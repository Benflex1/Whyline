import type {
  GitBlameAttribution,
  GitCommit,
  GitHunk,
  GitPathChange,
  GitPathChangeKind,
  ParentSelection,
  RepositoryContext,
  ResolvedCodeLocation,
} from "../provenance/model.js";
import { OperationalError } from "../whyline-error.js";
import {
  decodeGitUtf8,
  requireGitSuccess,
  type GitResult,
  type GitRunner,
} from "./git-process.js";
import { decodeGitPath } from "./git-path.js";
import { parseUnifiedDiff } from "./bounded-unified-diff.js";
export { parseUnifiedDiff } from "./bounded-unified-diff.js";

const MAX_COMMIT_BODY_BYTES = 8192;

const COMMIT_FORMAT = [
  "%H",
  "%P",
  "%an",
  "%ae",
  "%aI",
  "%cn",
  "%ce",
  "%cI",
  "%s",
  "%B",
].join("%x00") + "%x00";

function boundedBody(value: string): { readonly body: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_COMMIT_BODY_BYTES) {
    return { body: value, truncated: false };
  }
  return {
    body: bytes.subarray(0, MAX_COMMIT_BODY_BYTES).toString("utf8"),
    truncated: true,
  };
}

export function parseCommitRecord(value: Buffer): GitCommit {
  const fields = decodeGitUtf8(value).split("\u0000");
  if (fields.length < 10) {
    throw new OperationalError("Git commit metadata was malformed");
  }
  const field = (index: number): string => {
    const current = fields[index];
    if (current === undefined) throw new OperationalError("Git commit metadata was incomplete");
    return current;
  };
  const id = field(0);
  const parentsField = field(1);
  const authorName = field(2);
  const authorEmail = field(3);
  const authoredAt = field(4);
  const committerName = field(5);
  const committerEmail = field(6);
  const committedAt = field(7);
  const subject = field(8);
  const bodyField = field(9);

  const bounded = boundedBody(bodyField);
  return {
    basis: "fact",
    id,
    parents: parentsField.length === 0 ? [] : parentsField.split(/\s+/),
    authorName,
    authorEmail,
    authoredAt,
    committerName,
    committerEmail,
    committedAt,
    subject,
    body: bounded.body,
    bodyTruncated: bounded.truncated,
  };
}

export function selectParent(
  commit: GitCommit,
  blame: GitBlameAttribution,
): ParentSelection {
  if (commit.parents.length === 0) {
    return { basis: "derived", kind: "root" };
  }

  if (commit.parents.length === 1) {
    const parent = commit.parents[0];
    if (parent === undefined) {
      throw new OperationalError("Git commit parent metadata was malformed");
    }
    return {
      basis: "derived",
      kind: "commit",
      commitId: parent,
      evidence: blame.previousCommit === parent ? "blame-previous" : "sole-parent",
    };
  }

  if (blame.previousCommit !== null && commit.parents.includes(blame.previousCommit)) {
    return {
      basis: "derived",
      kind: "commit",
      commitId: blame.previousCommit,
      evidence: "blame-previous",
    };
  }
  return { basis: "derived", kind: "ambiguous", parentIds: commit.parents };
}

function parseStatusToken(value: string): {
  readonly kind: GitPathChangeKind;
  readonly similarity: number | null;
} {
  const letter = value[0];
  const scoreText = value.slice(1);
  const score = scoreText.length === 0 ? null : Number(scoreText);
  const similarity = score !== null && Number.isFinite(score) ? score : null;
  switch (letter) {
    case "A": return { kind: "added", similarity };
    case "M": return { kind: "modified", similarity };
    case "D": return { kind: "deleted", similarity };
    case "R": return { kind: "renamed", similarity };
    case "C": return { kind: "copied", similarity };
    case "T": return { kind: "type-changed", similarity };
    case "U": return { kind: "unmerged", similarity };
    default: return { kind: "unknown", similarity };
  }
}

export function parseNameStatus(value: Buffer): GitPathChange[] {
  const tokens = decodeGitUtf8(value).split("\u0000");
  const changes: GitPathChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (status === undefined || status.length === 0) continue;
    const parsedStatus = /^([ACDMRTUX])(?:([0-9]+))?$/.exec(status);
    if (parsedStatus === null) {
      throw new OperationalError("Git changed-path output was malformed");
    }

    const pathOne = tokens[index];
    index += 1;
    if (pathOne === undefined) {
      throw new OperationalError("Git changed-path output was incomplete");
    }
    const { kind, similarity } = parseStatusToken(status);
    if (kind === "renamed" || kind === "copied") {
      const pathTwo = tokens[index];
      index += 1;
      if (pathTwo === undefined) {
        throw new OperationalError("Git rename/copy output was incomplete");
      }
      changes.push({
        basis: "derived",
        kind,
        oldPath: decodeGitPath(pathOne),
        newPath: decodeGitPath(pathTwo),
        similarity,
      });
    } else {
      const decoded = decodeGitPath(pathOne);
      changes.push({
        basis: "derived",
        kind,
        oldPath: kind === "added" ? null : decoded,
        newPath: kind === "deleted" ? null : decoded,
        similarity,
      });
    }
  }
  return changes;
}


export interface CommitInspection {
  readonly commit: GitCommit;
  readonly parent: ParentSelection;
  readonly changedPaths: readonly GitPathChange[];
  readonly relevantHunks: readonly GitHunk[];
  readonly limitations: readonly string[];
}

function parentRevision(parent: ParentSelection): string | null {
  return parent.kind === "commit" ? parent.commitId : null;
}

export async function loadCommitMetadata(
  runner: GitRunner,
  context: RepositoryContext,
  objectId: string,
): Promise<GitCommit> {
  const showResult = await requireGitSuccess(
    runner,
    ["show", "-s", "--no-color", "--no-show-signature", "--format=" + COMMIT_FORMAT, objectId],
    context.worktreeRoot,
    "commit inspection",
  );
  return parseCommitRecord(showResult.stdout);
}

async function objectExists(
  runner: GitRunner,
  cwd: string,
  objectId: string,
): Promise<boolean> {
  let result: GitResult;
  try {
    result = await runner.run(["cat-file", "-e", `${objectId}^{commit}`], { cwd });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Git process error";
    throw new OperationalError(`could not inspect parent history: ${message}`);
  }
  return result.exitCode === 0;
}

async function emptyTreeId(runner: GitRunner, cwd: string): Promise<string> {
  const result = await requireGitSuccess(
    runner,
    ["hash-object", "-t", "tree", "--stdin"],
    cwd,
    "empty tree resolution",
    Buffer.alloc(0),
  );
  const id = decodeGitUtf8(result.stdout).trim();
  if (!/^[0-9a-fA-F]+$/.test(id)) {
    throw new OperationalError("empty tree resolution returned an invalid object ID");
  }
  return id;
}

function diffTreeArgs(commit: GitCommit, parent: ParentSelection): string[] {
  return parent.kind === "root"
    ? ["-c", "core.quotePath=false", "diff-tree", "--root", "-r", "-z", "--name-status", "-M", "--no-commit-id", commit.id]
    : ["-c", "core.quotePath=false", "diff-tree", "-r", "-z", "--name-status", "-M", "--no-commit-id", parentRevision(parent) ?? "", commit.id];
}

function diffPaths(
  location: ResolvedCodeLocation,
  blame: GitBlameAttribution,
  changes: readonly GitPathChange[],
): string[] {
  const paths = new Set<string>();
  const add = (value: string | null): void => {
    if (value !== null && value.length > 0) paths.add(value);
  };
  add(location.repositoryPath);
  add(blame.filename);
  add(blame.previousPath);
  for (const change of changes) {
    if (paths.has(change.oldPath ?? "") || paths.has(change.newPath ?? "")) {
      add(change.oldPath);
      add(change.newPath);
    }
  }
  return [...paths];
}

function pathMatchesHunk(hunk: GitHunk, paths: ReadonlySet<string>): boolean {
  return (hunk.oldPath !== null && paths.has(hunk.oldPath))
    || (hunk.newPath !== null && paths.has(hunk.newPath));
}

export async function inspectCommitEvidence(
  runner: GitRunner,
  context: RepositoryContext,
  location: ResolvedCodeLocation,
  blame: GitBlameAttribution,
  commit: GitCommit,
  parent: ParentSelection,
  targetLines?: ReadonlySet<number>,
): Promise<CommitInspection> {
  const limitations: string[] = [];

  if (context.isShallow) {
    limitations.push("The repository is shallow; visible history may omit required parent objects.");
  }

  if (parent.kind === "ambiguous") {
    limitations.push("Relevant parent: ambiguous; merge history was not reduced to a first parent.");
    return { commit, parent, changedPaths: [], relevantHunks: [], limitations };
  }
  if (parent.kind === "unavailable") {
    limitations.push("The visible history does not establish whether the blamed commit is a root; parent comparison is unavailable.");
    return { commit, parent, changedPaths: [], relevantHunks: [], limitations };
  }

  let parentRevisionId = parentRevision(parent);
  if (parent.kind === "commit" && parentRevisionId !== null) {
    if (!(await objectExists(runner, context.worktreeRoot, parentRevisionId))) {
      limitations.push("The selected parent object is unavailable; history may be shallow or incomplete.");
      return { commit, parent, changedPaths: [], relevantHunks: [], limitations };
    }
  }

  const changedResult = await requireGitSuccess(
    runner,
    diffTreeArgs(commit, parent),
    context.worktreeRoot,
    "changed-path inspection",
  );
  const changedPaths = parseNameStatus(changedResult.stdout);

  const paths = diffPaths(location, blame, changedPaths);
  if (paths.length === 0) {
    limitations.push("No relevant path was available for the parent comparison.");
    return { commit, parent, changedPaths, relevantHunks: [], limitations };
  }

  const parentForDiff = parent.kind === "root"
    ? await emptyTreeId(runner, context.worktreeRoot)
    : parentRevisionId;
  if (parentForDiff === null) {
    throw new OperationalError("selected parent comparison was malformed");
  }

  const diffArgs = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--find-renames",
    "--unified=3",
    parentForDiff,
    commit.id,
    "--",
    ...paths,
  ];
  const diffResult = await requireGitSuccess(
    runner,
    diffArgs,
    context.worktreeRoot,
    "relevant diff inspection",
  );

  const parsedHunks = parseUnifiedDiff(
    diffResult.stdout,
    targetLines ?? blame.finalLine,
  );
  const relevantPaths = new Set(paths);
  const matching = parsedHunks.filter((hunk) => hunk.targetLineKind !== null && pathMatchesHunk(hunk, relevantPaths));
  const fallback = parsedHunks.filter((hunk) => hunk.targetLineKind !== null);
  const relevantHunks = matching.length > 0 ? matching : fallback;
  if (relevantHunks.length === 0) {
    limitations.push("No unified-diff hunk contains the attributed final line; this may be a rename-only or context attribution.");
  }
  if (relevantHunks.some((hunk) => hunk.truncated)) {
    limitations.push("The relevant diff hunk was bounded for report safety.");
  }

  return { commit, parent, changedPaths, relevantHunks, limitations };
}

export async function inspectCommit(
  runner: GitRunner,
  context: RepositoryContext,
  location: ResolvedCodeLocation,
  blame: GitBlameAttribution,
): Promise<CommitInspection> {
  const commit = await loadCommitMetadata(runner, context, blame.objectId);
  const parent: ParentSelection = context.isShallow && commit.parents.length === 0
    ? { basis: "derived", kind: "unavailable", reason: "shallow-history" }
    : selectParent(commit, blame);
  return inspectCommitEvidence(runner, context, location, blame, commit, parent);
}
