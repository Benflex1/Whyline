import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type {
  CorrelationHunk,
  WorktreeCorrelationHunk,
  WorktreeTargetConstruction,
} from "../correlation/model.js";
import type {
  GitHunk,
  RepositoryContext,
} from "../provenance/model.js";
import type { RangeLineSpan } from "../provenance/range-model.js";
import type { CurrentSourceSnapshot } from "../location/resolve-location.js";
import { OperationalError } from "../whyline-error.js";
import {
  decodeGitUtf8,
  type GitResult,
  type GitRunner,
} from "./git-process.js";
import { parseBoundedUnifiedDiff } from "./bounded-unified-diff.js";

export const MAX_WORKTREE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_WORKTREE_HUNK_FINGERPRINTS = 128;
export const MAX_WORKTREE_PROOF_LINES = 32;
export const MIN_WORKTREE_DISTINCTIVE_LINES = 2;
export const MIN_WORKTREE_ALPHANUMERIC_CHARACTERS = 40;

const BOILERPLATE_LINES = new Set([
  "begin patch",
  "end patch",
  "no newline at end of file",
  "pass",
  "return;",
  "return null;",
  "return undefined;",
]);

function digestLine(value: string): string {
  return createHash("sha256")
    .update(value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), "utf8")
    .digest("hex");
}

function isDistinctiveLine(value: string): boolean {
  const line = value.trim();
  if (
    line.length < 4
    || /^[\p{P}\p{S}\s]+$/u.test(line)
    || /^[A-Za-z_$][\w$]*$/.test(line)
  ) return false;
  return !BOILERPLATE_LINES.has(line.toLowerCase())
    && !/^(?:return|throw|yield)\s+[A-Za-z_$][\w$]*;?$/.test(line);
}

function alphanumericCount(value: string): number {
  return [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

interface StatusDiagnostics {
  readonly index: string;
  readonly worktree: string;
  readonly untracked: boolean;
  readonly unmerged: boolean;
}

interface IndexDiagnostics {
  readonly present: boolean;
  readonly stageZero: boolean;
  readonly nonZeroStage: boolean;
}

interface RawChange {
  readonly status: string;
  readonly path: string;
}

interface MappedLine {
  readonly line: number;
  readonly text: string;
}

interface AddedRun {
  readonly hunk: GitHunk;
  readonly lines: readonly MappedLine[];
}

function operational(operation: string, error: unknown): never {
  if (error instanceof OperationalError) throw error;
  const message = error instanceof Error ? error.message : "unknown process error";
  throw new OperationalError(`${operation} could not start: ${message}`);
}

async function runGit(
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
  operation: string,
): Promise<GitResult> {
  try {
    return await runner.run(args, { cwd });
  } catch (error: unknown) {
    return operational(operation, error);
  }
}

function parseStatus(value: Buffer, repositoryPath: string): StatusDiagnostics {
  const records = decodeGitUtf8(value).split("\u0000").filter((record) => record.length > 0);
  const record = records.find((item) => {
    if (item.startsWith("? ")) return item.slice(2) === repositoryPath;
    if (item.startsWith("1 ")) return item.split(" ").slice(8).join(" ") === repositoryPath;
    if (item.startsWith("2 ")) return item.split(" ").slice(9).join(" ") === repositoryPath;
    if (item.startsWith("u ")) return item.split(" ").slice(10).join(" ") === repositoryPath;
    return false;
  });
  if (record === undefined) {
    return { index: ".", worktree: ".", untracked: false, unmerged: false };
  }
  if (record.startsWith("? ")) {
    return { index: ".", worktree: "?", untracked: true, unmerged: false };
  }
  const fields = record.split(" ");
  const kind = fields[0];
  if (kind === "u") {
    return { index: "U", worktree: "U", untracked: false, unmerged: true };
  }
  if (kind !== "1" && kind !== "2") {
    throw new OperationalError("Git status output was malformed");
  }
  const xy = fields[1];
  if (xy === undefined || xy.length !== 2) {
    throw new OperationalError("Git status output was malformed");
  }
  return {
    index: xy[0] ?? ".",
    worktree: xy[1] ?? ".",
    untracked: false,
    unmerged: false,
  };
}

function parseIndex(value: Buffer, repositoryPath: string): IndexDiagnostics {
  const records = decodeGitUtf8(value).split("\u0000").filter((record) => record.length > 0);
  let present = false;
  let stageZero = false;
  let nonZeroStage = false;
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new OperationalError("Git index output was malformed");
    const metadata = record.slice(0, tab).split(" ");
    if (metadata.length !== 3 || metadata[2] === undefined || record.slice(tab + 1) !== repositoryPath) {
      if (record.slice(tab + 1) !== repositoryPath) continue;
      throw new OperationalError("Git index output was malformed");
    }
    present = true;
    if (metadata[2] === "0") stageZero = true;
    else if (/^[1-3]$/.test(metadata[2])) nonZeroStage = true;
    else throw new OperationalError("Git index stage was malformed");
  }
  return { present, stageZero, nonZeroStage };
}

function parseHeadTree(value: Buffer, repositoryPath: string): string | null {
  const records = decodeGitUtf8(value).split("\u0000").filter((record) => record.length > 0);
  if (records.length === 0) return null;
  if (records.length !== 1) throw new OperationalError("Git HEAD path output was malformed");
  const record = records[0] as string;
  const tab = record.indexOf("\t");
  if (tab < 0 || record.slice(tab + 1) !== repositoryPath) {
    throw new OperationalError("Git HEAD path output was malformed");
  }
  const fields = record.slice(0, tab).split(" ");
  if (fields.length !== 3 || fields[1] !== "blob" || fields[2] === undefined) {
    throw new OperationalError("Git HEAD path output was malformed");
  }
  return fields[2];
}

function parseRawDiff(value: Buffer, repositoryPath: string): readonly RawChange[] {
  const tokens = decodeGitUtf8(value).split("\u0000").filter((token) => token.length > 0);
  const changes: RawChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const metadata = tokens[index++] as string;
    const path = tokens[index++];
    if (path === undefined) throw new OperationalError("Git raw diff output was incomplete");
    const fields = metadata.split(" ");
    if (fields.length < 5 || !metadata.startsWith(":")) {
      throw new OperationalError("Git raw diff output was malformed");
    }
    const status = fields[fields.length - 1];
    if (status === undefined || !/^[A-Z][0-9]*$/.test(status)) {
      throw new OperationalError("Git raw diff status was malformed");
    }
    if (path !== repositoryPath) throw new OperationalError("Git raw diff escaped the target path");
    changes.push({ status: status[0] as string, path });
  }
  return changes;
}

function validateObjectId(value: string, objectFormat: string): boolean {
  const length = objectFormat === "sha256" ? 64 : 40;
  return new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value);
}

function decodeRequiredText(value: Buffer): boolean {
  if (value.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return true;
  } catch {
    return false;
  }
}

function stagingFor(
  status: StatusDiagnostics,
  index: IndexDiagnostics,
  headPresent: boolean,
): "staged" | "unstaged" | "partially-staged" | "untracked" | "unknown" {
  if (status.unmerged || index.nonZeroStage) return "unknown";
    if (status.untracked || !headPresent) {
      if (status.index !== "." && status.worktree !== ".") return "partially-staged";
      if (status.index !== ".") return "staged";
      if (!status.untracked && status.worktree !== ".") return "unstaged";
      return "untracked";
  }
  if (status.index !== "." && status.worktree !== ".") return "partially-staged";
  if (status.index !== ".") return "staged";
  return "unstaged";
}

function querySpans(lines: readonly number[]): readonly RangeLineSpan[] {
  const sorted = [...new Set(lines)].sort((left, right) => left - right);
  const spans: RangeLineSpan[] = [];
  for (const line of sorted) {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.endLine + 1 === line) {
      spans[spans.length - 1] = { startLine: last.startLine, endLine: line };
    } else {
      spans.push({ startLine: line, endLine: line });
    }
  }
  return spans;
}

function targetWindow(
  run: readonly MappedLine[],
  queried: readonly number[],
): readonly MappedLine[] {
  const queryStart = queried[0] as number;
  const queryEnd = queried[queried.length - 1] as number;
  const queryLength = queryEnd - queryStart + 1;
  let start = Math.max(run[0]?.line ?? queryStart, queryStart - Math.floor((MAX_WORKTREE_PROOF_LINES - queryLength) / 2));
  let end = Math.min(run[run.length - 1]?.line ?? queryEnd, start + MAX_WORKTREE_PROOF_LINES - 1);
  if (end < queryEnd) {
    end = queryEnd;
    start = Math.max(run[0]?.line ?? queryStart, end - MAX_WORKTREE_PROOF_LINES + 1);
  }
  return run.filter((line) => line.line >= start && line.line <= end);
}

function worktreeHunk(
  hunk: GitHunk,
  operation: "update" | "add",
  lines: readonly MappedLine[],
  queried: readonly number[],
): WorktreeCorrelationHunk {
  const all = lines.map((line) => digestLine(line.text));
  const distinctive = lines
    .filter((line) => isDistinctiveLine(line.text))
    .map((line) => digestLine(line.text));
  const target: CorrelationHunk = {
    oldPath: hunk.oldPath,
    newPath: hunk.newPath,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: lines[0]?.line ?? hunk.newStart,
    newLines: lines.length,
    targetLineKind: "added",
    addedLineFingerprints: all,
    deletedLineFingerprints: [],
    distinctiveAddedLineFingerprints: [...new Set(distinctive)],
    distinctiveDeletedLineFingerprints: [],
    truncated: false,
  };
  return {
    ...target,
    basis: "derived",
    operation,
    queriedSpans: querySpans(queried),
    currentLineFingerprints: all,
    currentDistinctiveLineFingerprints: [...new Set(distinctive)],
    currentLineAlphanumericCounts: lines.map((line) => alphanumericCount(line.text)),
    complete: true,
  };
}

function evidenceDigest(
  repositoryPath: string,
  changeKind: "modified" | "added",
  constructions: readonly WorktreeTargetConstruction[],
): string {
  const material = constructions.map((construction) => {
    if (construction.status !== "ready") {
      return {
        status: construction.status,
        reason: construction.reason,
        queriedSpans: construction.queriedSpans,
      };
    }
    return {
      status: construction.status,
      queriedSpans: construction.queriedSpans,
      changeKind: construction.target.changeKind,
      targetPath: construction.target.targetPath,
      hunks: construction.target.relevantHunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        complete: hunk.complete,
        currentLineFingerprints: hunk.currentLineFingerprints,
      })),
    };
  });
  return createHash("sha256")
    .update(JSON.stringify({ repositoryPath, changeKind, constructions: material }), "utf8")
    .digest("hex");
}

function readyEvidenceDigest(
  repositoryPath: string,
  changeKind: "modified" | "added",
  queriedSpans: readonly RangeLineSpan[],
  hunk: WorktreeCorrelationHunk,
): string {
  return evidenceDigest(repositoryPath, changeKind, [{
    status: "ready",
    queriedSpans,
    target: {
      kind: "worktree",
      basis: "derived",
      repository: {
        worktreeRoot: "",
        gitDir: "",
        commonGitDir: "",
        objectFormat: "",
        worktrees: [],
      },
      baseCommitId: "",
      targetPath: repositoryPath,
      changeKind,
      staging: "unknown",
      queriedSpans,
      relevantHunks: [hunk],
      targetSnapshot: {
        baseCommitId: "",
        repositoryPath,
        changeKind,
        fileSnapshot: { size: 0, mtimeMs: 0, ino: 0, dev: 0, digest: "" },
        evidenceDigest: "",
      },
    },
  }]);
}

type WorktreeConstructionReason = Extract<WorktreeTargetConstruction, { readonly reason: string }>["reason"];

function limitationConstruction(
  status: WorktreeTargetConstruction["status"],
  queriedLines: readonly number[],
  reason: WorktreeConstructionReason,
  limitations: readonly string[],
): WorktreeTargetConstruction {
  return { status, queriedSpans: querySpans(queriedLines), reason, limitations } as WorktreeTargetConstruction;
}

function makeTarget(
  repository: RepositoryContext,
  source: CurrentSourceSnapshot,
  changeKind: "modified" | "added",
  staging: ReturnType<typeof stagingFor>,
  hunk: WorktreeCorrelationHunk,
  queriedLines: readonly number[],
): WorktreeTargetConstruction {
  const target = {
    kind: "worktree" as const,
    basis: "derived" as const,
    repository: {
      worktreeRoot: repository.worktreeRoot,
      gitDir: repository.gitDir,
      commonGitDir: repository.commonGitDir,
      objectFormat: repository.objectFormat,
      worktrees: repository.worktrees.map((worktree) => ({
        path: worktree.path,
        commonGitDir: repository.commonGitDir,
      })),
    },
    baseCommitId: repository.headCommit,
    targetPath: source.repositoryPath,
    changeKind,
    staging,
    queriedSpans: querySpans(queriedLines),
    relevantHunks: [hunk] as [WorktreeCorrelationHunk],
    targetSnapshot: {
      baseCommitId: repository.headCommit,
      repositoryPath: source.repositoryPath,
      changeKind,
      fileSnapshot: source.fileSnapshot,
      evidenceDigest: readyEvidenceDigest(source.repositoryPath, changeKind, querySpans(queriedLines), hunk),
    },
  };
  return { status: "ready", queriedSpans: querySpans(queriedLines), target };
}

function addConstruction(
  repository: RepositoryContext,
  source: CurrentSourceSnapshot,
  changeKind: "modified" | "added",
  staging: ReturnType<typeof stagingFor>,
  hunk: GitHunk,
  run: readonly MappedLine[],
  queriedLines: readonly number[],
  constructions: WorktreeTargetConstruction[],
): void {
  const sorted = [...queriedLines].sort((left, right) => left - right);
  for (let index = 0; index < sorted.length;) {
    const group = [sorted[index] as number];
    while (group.length < MAX_WORKTREE_PROOF_LINES) {
      const next = sorted[index + group.length];
      const previous = group[group.length - 1] as number;
      if (next === undefined || next !== previous + 1) break;
      group.push(next);
    }
    index += group.length;
    const window = targetWindow(run, group);
    if (window.length === 0) continue;
    const distinctive = new Set(window.filter((line) => isDistinctiveLine(line.text)).map((line) => digestLine(line.text)));
    const alphanumeric = window.reduce((total, line) => total + alphanumericCount(line.text), 0);
    if (distinctive.size < MIN_WORKTREE_DISTINCTIVE_LINES || alphanumeric < MIN_WORKTREE_ALPHANUMERIC_CHARACTERS) {
      constructions.push({
        status: "insufficient",
        queriedSpans: querySpans(group),
        reason: "insufficient-distinctive-material",
        limitations: ["The query-local worktree material did not meet the exact distinctive-material floor."],
      });
      continue;
    }
    const worktree = worktreeHunk(hunk, changeKind === "added" ? "add" : "update", window, group);
    constructions.push(makeTarget(repository, source, changeKind, staging, worktree, group));
  }
}

function addedRuns(hunk: GitHunk): readonly AddedRun[] {
  const runs: AddedRun[] = [];
  let current: MappedLine[] = [];
  let nextLine = hunk.newStart;
  const finish = (): void => {
    if (current.length > 0) runs.push({ hunk, lines: current });
    current = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "added") {
      current.push({ line: nextLine, text: line.text });
      nextLine += 1;
    } else if (line.kind === "context") {
      finish();
      nextLine += 1;
    } else if (line.kind === "deleted") {
      finish();
    }
  }
  finish();
  return runs;
}

function syntheticRuns(source: CurrentSourceSnapshot): readonly AddedRun[] {
  return [{
    hunk: {
      basis: "derived",
      oldPath: null,
      newPath: source.repositoryPath,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: source.lines.length,
      targetLineKind: "added",
      lines: source.lines.map((text) => ({ kind: "added" as const, text })),
      raw: "",
      truncated: false,
    },
    lines: source.lines.map((text, index) => ({ line: index + 1, text })),
  }];
}

function relevantRuns(
  runs: readonly AddedRun[],
  queriedLines: readonly number[],
): readonly { readonly run: AddedRun; readonly queriedLines: readonly number[] }[] {
  return runs
    .map((run) => ({ run, queriedLines: queriedLines.filter((line) => run.lines.some((candidate) => candidate.line === line)) }))
    .filter((value) => value.queriedLines.length > 0);
}

export interface WorktreeChangeInspection {
  readonly repositoryPath: string;
  readonly baseCommitId: string;
  readonly constructions: readonly WorktreeTargetConstruction[];
  readonly evidenceDigest: string;
}

export async function inspectWorktreeChange(
  runner: GitRunner,
  repository: RepositoryContext,
  source: CurrentSourceSnapshot,
  queriedLines: readonly number[],
): Promise<WorktreeChangeInspection> {
  const lines = [...new Set(queriedLines)].sort((left, right) => left - right);
  const pathArg = source.repositoryPath;
  const statusResult = await runGit(
    runner,
    ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--", pathArg],
    repository.worktreeRoot,
    "worktree status inspection",
  );
  if (statusResult.exitCode !== 0) throw new OperationalError("worktree status inspection failed");
  const status = parseStatus(statusResult.stdout, pathArg);
  const indexResult = await runGit(runner, ["ls-files", "--stage", "-z", "--", pathArg], repository.worktreeRoot, "worktree index inspection");
  if (indexResult.exitCode !== 0) throw new OperationalError("worktree index inspection failed");
  const index = parseIndex(indexResult.stdout, pathArg);
  const treeResult = await runGit(runner, ["ls-tree", "-z", "--full-tree", "HEAD", "--", pathArg], repository.worktreeRoot, "HEAD path inspection");
  if (treeResult.exitCode !== 0) throw new OperationalError("HEAD path inspection failed");
  const headBlob = parseHeadTree(treeResult.stdout, pathArg);
  const headPresent = headBlob !== null;
  const staging = stagingFor(status, index, headPresent);

  if (status.unmerged) {
    const construction = limitationConstruction("unavailable", lines, "unmerged", ["The target path is unmerged; no parent or index side was selected."]);
    return {
      repositoryPath: pathArg,
      baseCommitId: repository.headCommit,
      constructions: [construction],
      evidenceDigest: evidenceDigest(pathArg, headPresent ? "modified" : "added", [construction]),
    };
  }
  if (source.fileSnapshot.size > MAX_WORKTREE_FILE_BYTES) {
    const construction = limitationConstruction("work-bound", lines, "file-too-large", ["The current file exceeded the bounded worktree material limit."]);
    return {
      repositoryPath: pathArg,
      baseCommitId: repository.headCommit,
      constructions: [construction],
      evidenceDigest: evidenceDigest(pathArg, headPresent ? "modified" : "added", [construction]),
    };
  }

  if (headBlob !== null) {
    if (!validateObjectId(headBlob, repository.objectFormat)) {
      throw new OperationalError("Git HEAD path returned an invalid object ID");
    }
    const sizeResult = await runGit(runner, ["cat-file", "-s", headBlob], repository.worktreeRoot, "HEAD blob size inspection");
    if (sizeResult.exitCode !== 0) {
      const construction = limitationConstruction("unavailable", lines, "missing-head-object", ["The required HEAD blob object was unavailable."]);
      return { repositoryPath: pathArg, baseCommitId: repository.headCommit, constructions: [construction], evidenceDigest: evidenceDigest(pathArg, "modified", [construction]) };
    }
    const sizeText = decodeGitUtf8(sizeResult.stdout).trim();
    if (!/^\d+$/.test(sizeText)) throw new OperationalError("HEAD blob size output was malformed");
    const headSize = Number(sizeText);
    if (!Number.isSafeInteger(headSize)) throw new OperationalError("HEAD blob size output was malformed");
    if (headSize > MAX_WORKTREE_FILE_BYTES) {
      const construction = limitationConstruction("work-bound", lines, "file-too-large", ["The required HEAD blob exceeded the bounded worktree material limit."]);
      return { repositoryPath: pathArg, baseCommitId: repository.headCommit, constructions: [construction], evidenceDigest: evidenceDigest(pathArg, "modified", [construction]) };
    }
    const blobResult = await runGit(runner, ["cat-file", "blob", headBlob], repository.worktreeRoot, "HEAD blob inspection");
    if (blobResult.exitCode !== 0 || !decodeRequiredText(blobResult.stdout)) {
      const construction = limitationConstruction("unavailable", lines, "incomplete-diff", ["Required HEAD text material was unavailable or not valid UTF-8."]);
      return { repositoryPath: pathArg, baseCommitId: repository.headCommit, constructions: [construction], evidenceDigest: evidenceDigest(pathArg, "modified", [construction]) };
    }
  }

  if (!headPresent) {
    const constructions: WorktreeTargetConstruction[] = [];
    for (const value of relevantRuns(syntheticRuns(source), lines)) {
      addConstruction(repository, source, "added", staging, value.run.hunk, value.run.lines, value.queriedLines, constructions);
    }
    if (constructions.length === 0) {
      constructions.push({
        status: "insufficient",
        queriedSpans: querySpans(lines),
        reason: "query-not-current-side-change",
        limitations: ["The query was not covered by current-side added material."],
      });
    }
    return {
      repositoryPath: pathArg,
      baseCommitId: repository.headCommit,
      constructions,
      evidenceDigest: evidenceDigest(pathArg, "added", constructions),
    };
  }

  const rawResult = await runGit(
    runner,
    ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--", pathArg],
    repository.worktreeRoot,
    "worktree raw diff inspection",
  );
  if (rawResult.exitCode !== 0) throw new OperationalError("worktree raw diff inspection failed");
  const rawChanges = parseRawDiff(rawResult.stdout, pathArg);
  if (rawChanges.length === 0) {
    const construction = limitationConstruction("insufficient", lines, "query-not-current-side-change", ["The queried current line was not an added line in the final HEAD-to-worktree change."]);
    return { repositoryPath: pathArg, baseCommitId: repository.headCommit, constructions: [construction], evidenceDigest: evidenceDigest(pathArg, "modified", [construction]) };
  }
  if (rawChanges.length !== 1 || !["M"].includes(rawChanges[0]?.status ?? "")) {
    const reason = rawChanges.some((change) => change.status === "U") ? "unmerged" : "unsupported-change-shape";
    const construction = limitationConstruction("unavailable", lines, reason, ["The current-path diff shape was not a supported update."]);
    return { repositoryPath: pathArg, baseCommitId: repository.headCommit, constructions: [construction], evidenceDigest: evidenceDigest(pathArg, "modified", [construction]) };
  }

  const patchResult = await runGit(
    runner,
    ["diff", "--patch", "--unified=0", "--no-indent-heuristic", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", pathArg],
    repository.worktreeRoot,
    "worktree patch inspection",
  );
  if (patchResult.exitCode !== 0) throw new OperationalError("worktree patch inspection failed");
  const parsedHunks = parseBoundedUnifiedDiff(patchResult.stdout, new Set(lines));
  if (parsedHunks.length === 0 || parsedHunks.some((hunk) => (hunk.oldPath !== pathArg && hunk.newPath !== pathArg))) {
    const construction = limitationConstruction("unavailable", lines, "incomplete-diff", ["The current-path patch did not contain a complete supported hunk."]);
    return { repositoryPath: pathArg, baseCommitId: repository.headCommit, constructions: [construction], evidenceDigest: evidenceDigest(pathArg, "modified", [construction]) };
  }
  const constructions: WorktreeTargetConstruction[] = [];
  const covered = new Set<number>();
  for (const hunk of parsedHunks) {
    const hunkEnd = hunk.newStart + Math.max(0, hunk.newLines - 1);
    const hunkQueries = lines.filter((line) => line >= hunk.newStart && line <= hunkEnd);
    if (hunkQueries.length === 0) continue;
    if (hunk.truncated) {
      constructions.push(limitationConstruction("work-bound", hunkQueries, "hunk-too-large", ["The relevant worktree hunk exceeded a bounded retained-material limit."]));
      for (const line of hunkQueries) covered.add(line);
      continue;
    }
    for (const run of addedRuns(hunk)) {
      const runQueries = hunkQueries.filter((line) => run.lines.some((candidate) => candidate.line === line));
      if (runQueries.length === 0) continue;
      for (const line of runQueries) covered.add(line);
      if (run.lines.length > MAX_WORKTREE_HUNK_FINGERPRINTS) {
        constructions.push(limitationConstruction("work-bound", runQueries, "hunk-too-large", ["The relevant worktree hunk exceeded the fingerprint bound."]));
      } else {
        addConstruction(repository, source, "modified", staging, hunk, run.lines, runQueries, constructions);
      }
    }
  }
  const uncovered = lines.filter((line) => !covered.has(line));
  if (uncovered.length > 0) {
    constructions.push({
      status: "insufficient",
      queriedSpans: querySpans(uncovered),
      reason: "query-not-current-side-change",
      limitations: ["The queried current line was not an added line in a complete current-side hunk."],
    });
  }
  if (constructions.length === 0) {
    constructions.push({
      status: "unavailable",
      queriedSpans: querySpans(lines),
      reason: "incomplete-diff",
      limitations: ["The current-path patch did not yield a query-local current-side hunk."],
    });
  }
  return {
    repositoryPath: pathArg,
    baseCommitId: repository.headCommit,
    constructions,
    evidenceDigest: evidenceDigest(pathArg, "modified", constructions),
  };
}
