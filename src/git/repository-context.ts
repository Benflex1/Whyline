import { realpath } from "node:fs/promises";
import path from "node:path";

import type {
  RepositoryContext,
  TargetFileState,
  WorktreeInfo,
} from "../provenance/model.js";
import { InvalidInputError, OperationalError } from "../whyline-error.js";
import {
  decodeGitUtf8,
  requireGitSuccess,
  type GitResult,
  type GitRunner,
} from "./git-process.js";

function singleLine(value: Buffer, label: string): string {
  const text = decodeGitUtf8(value).replace(/\r\n/g, "\n");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0) {
    throw new OperationalError(`${label} returned unexpected output`);
  }
  return lines[0];
}

function normalizeGitPath(value: string): string {
  return path.resolve(value);
}

function parseBooleanLine(value: Buffer, label: string): boolean {
  const parsed = singleLine(value, label);
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new OperationalError(`${label} returned unexpected output`);
}

function parseBranchOutput(result: GitResult): string | null {
  if (result.exitCode === 1) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw new OperationalError("could not determine the current branch");
  }
  return singleLine(result.stdout, "current branch");
}

function isNotRepositoryError(error: unknown): boolean {
  return error instanceof OperationalError
    && /not a git repository|cannot find repository|not inside a git work tree/i.test(error.message);
}

function parseWorktreeRecord(tokens: readonly string[]): WorktreeInfo | null {
  let worktreePath: string | undefined;
  let headCommit: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let bare = false;
  let locked = false;
  let prunable = false;

  for (const token of tokens) {
    const separator = token.indexOf(" ");
    const key = separator < 0 ? token : token.slice(0, separator);
    const value = separator < 0 ? "" : token.slice(separator + 1);
    switch (key) {
      case "worktree":
        worktreePath = normalizeGitPath(value);
        break;
      case "HEAD":
        headCommit = value.length === 0 ? null : value;
        break;
      case "branch":
        branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
        break;
      case "detached":
        detached = true;
        break;
      case "bare":
        bare = true;
        break;
      case "locked":
        locked = true;
        break;
      case "prunable":
        prunable = true;
        break;
      default:
        break;
    }
  }

  return worktreePath === undefined
    ? null
    : { path: worktreePath, headCommit, branch, detached, bare, locked, prunable };
}

async function canonicalizePathWithExistingParent(value: string): Promise<string> {
  const target = path.resolve(value);
  let candidate = target;
  while (true) {
    try {
      const canonical = await realpath(candidate);
      return path.resolve(canonical, path.relative(candidate, target));
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return target;
      candidate = parent;
    }
  }
}

async function canonicalizeWorktreePath(worktree: WorktreeInfo): Promise<WorktreeInfo> {
  // Prunable worktrees may no longer exist. Canonicalizing the nearest
  // existing parent still resolves macOS aliases while retaining the missing
  // suffix needed for bounded deleted-worktree correlation.
  return { ...worktree, path: await canonicalizePathWithExistingParent(worktree.path) };
}

export function parseWorktreeList(value: Buffer): WorktreeInfo[] {
  const tokens = decodeGitUtf8(value).split("\u0000");
  const records: WorktreeInfo[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const parsed = parseWorktreeRecord(current);
    if (parsed !== null) records.push(parsed);
    current = [];
  };

  for (const token of tokens) {
    if (token.length === 0) {
      flush();
    } else {
      current.push(token);
    }
  }
  flush();
  return records;
}

export async function discoverRepositoryContext(
  runner: GitRunner,
  startDirectory: string,
): Promise<RepositoryContext> {
  let bareResult: GitResult;
  try {
    bareResult = await requireGitSuccess(
      runner,
      ["rev-parse", "--is-bare-repository"],
      startDirectory,
      "repository discovery",
    );
  } catch (error: unknown) {
    if (isNotRepositoryError(error)) {
      throw new InvalidInputError("current directory is not inside a Git worktree");
    }
    throw error;
  }
  if (parseBooleanLine(bareResult.stdout, "bare repository check")) {
    throw new InvalidInputError("bare repositories are unsupported");
  }

  let rootResult: GitResult;
  try {
    rootResult = await requireGitSuccess(
      runner,
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      startDirectory,
      "worktree discovery",
    );
  } catch (error: unknown) {
    if (isNotRepositoryError(error)) {
      throw new InvalidInputError("current directory is not inside a Git worktree");
    }
    throw error;
  }

  const worktreeRoot = await realpath(singleLine(rootResult.stdout, "worktree root"));
  const gitDir = normalizeGitPath(singleLine(
    (await requireGitSuccess(
      runner,
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      startDirectory,
      "Git directory discovery",
    )).stdout,
    "Git directory",
  ));
  const commonGitDir = normalizeGitPath(singleLine(
    (await requireGitSuccess(
      runner,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      startDirectory,
      "common Git directory discovery",
    )).stdout,
    "common Git directory",
  ));
  const objectFormat = singleLine(
    (await requireGitSuccess(
      runner,
      ["rev-parse", "--show-object-format"],
      startDirectory,
      "object-format discovery",
    )).stdout,
    "object format",
  );
  const isShallowResult = await requireGitSuccess(
    runner,
    ["rev-parse", "--is-shallow-repository"],
    startDirectory,
    "shallow-repository discovery",
  );

  let headResult: GitResult;
  try {
    headResult = await requireGitSuccess(
      runner,
      ["rev-parse", "--verify", "HEAD"],
      startDirectory,
      "HEAD discovery",
    );
  } catch (error: unknown) {
    if (error instanceof OperationalError && /needed a single revision|bad revision|ambiguous argument ['"]?HEAD/i.test(error.message)) {
      throw new InvalidInputError("unborn HEADs are unsupported");
    }
    throw error;
  }

  const branchResult = await runner.run(
    ["symbolic-ref", "-q", "--short", "HEAD"],
    { cwd: startDirectory },
  );
  const branch = parseBranchOutput(branchResult);
  const worktreeResult = await requireGitSuccess(
    runner,
    ["worktree", "list", "--porcelain", "-z"],
    startDirectory,
    "worktree mapping discovery",
  );

  const worktrees = await Promise.all(
    parseWorktreeList(worktreeResult.stdout).map(canonicalizeWorktreePath),
  );

  return {
    worktreeRoot,
    gitDir,
    commonGitDir,
    objectFormat,
    isShallow: parseBooleanLine(isShallowResult.stdout, "shallow repository check"),
    headCommit: singleLine(headResult.stdout, "HEAD"),
    branch,
    worktrees,
  };
}

export function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export interface TargetStatus {
  readonly state: TargetFileState;
  readonly dirty: boolean;
  readonly tracked: boolean;
}

function statusState(record: string): TargetFileState {
  if (record.startsWith("? ")) return "untracked";
  if (record.startsWith("u ")) return "unmerged";

  const fields = record.split(" ");
  const xy = fields[1] ?? "";
  if (xy.includes("D")) return "deleted";
  return "modified";
}

export function parseStatus(value: Buffer): TargetFileState | null {
  const records = decodeGitUtf8(value).split("\u0000").filter((record) => record.length > 0);
  const first = records[0];
  return first === undefined ? null : statusState(first);
}

async function isTracked(
  runner: GitRunner,
  cwd: string,
  repositoryPath: string,
): Promise<boolean> {
  const result = await runner.run(
    ["ls-files", "--error-unmatch", "--", repositoryPath],
    { cwd },
  );
  return result.exitCode === 0;
}

async function isInHead(
  runner: GitRunner,
  cwd: string,
  repositoryPath: string,
): Promise<boolean> {
  const result = await runner.run(
    ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", repositoryPath],
    { cwd },
  );
  if (result.exitCode !== 0) {
    throw new OperationalError("could not determine whether the target exists in HEAD");
  }
  return decodeGitUtf8(result.stdout).split("\u0000").some((item) => item === repositoryPath);
}

export async function readTargetStatus(
  runner: GitRunner,
  context: RepositoryContext,
  repositoryPath: string,
): Promise<TargetStatus> {
  const result = await requireGitSuccess(
    runner,
    ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--", repositoryPath],
    context.worktreeRoot,
    "target status inspection",
  );
  const parsed = parseStatus(result.stdout);
  if (parsed !== null) {
    if (!(await isInHead(runner, context.worktreeRoot, repositoryPath))) {
      return { state: "untracked", dirty: true, tracked: false };
    }
    return { state: parsed, dirty: parsed !== "clean", tracked: parsed !== "untracked" };
  }

  const tracked = await isTracked(runner, context.worktreeRoot, repositoryPath);
  if (tracked && !(await isInHead(runner, context.worktreeRoot, repositoryPath))) {
    return { state: "untracked", dirty: true, tracked: false };
  }
  return tracked
    ? { state: "clean", dirty: false, tracked: true }
    : { state: "untracked", dirty: true, tracked: false };
}
