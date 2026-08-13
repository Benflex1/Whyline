import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { GitRunner } from "../git/git-process.js";
import {
  isWithinDirectory,
  readTargetStatus,
  type TargetStatus,
} from "../git/repository-context.js";
import type {
  CodeLocation,
  FileSnapshot,
  RepositoryContext,
  ResolvedCodeLocation,
  ResolvedRangeCodeLocation,
} from "../provenance/model.js";
import { InvalidInputError, OperationalError } from "../whyline-error.js";
import type { ParsedLocation } from "./parse-location.js";
import { MAX_RANGE_LINES, type RangeLocationQuery } from "./parse-location.js";

const MAX_RETAINED_LINE_LENGTH = 4096;

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeLineContent(value: string): string {
  return value.length > MAX_RETAINED_LINE_LENGTH
    ? value.slice(0, MAX_RETAINED_LINE_LENGTH)
    : value;
}

function splitTextLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function snapshotFromBytes(
  metadata: { readonly size: number; readonly mtimeMs: number; readonly ino: number; readonly dev: number },
  bytes: Buffer,
): FileSnapshot {
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ino: metadata.ino,
    dev: metadata.dev,
    digest: digest(bytes),
  };
}

async function readSnapshot(filePath: string): Promise<{ readonly bytes: Buffer; readonly snapshot: FileSnapshot }> {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch {
    throw new InvalidInputError("target file does not exist");
  }
  if (!metadata.isFile()) {
    throw new InvalidInputError("target must be a regular file");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    throw new OperationalError("target file could not be read");
  }
  return { bytes, snapshot: snapshotFromBytes(metadata, bytes) };
}

function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) {
    throw new InvalidInputError("binary targets are unsupported");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidInputError("non-UTF-8 binary targets are unsupported");
  }
}

async function rejectRepositorySwitchThroughSymlink(
  runner: GitRunner,
  context: RepositoryContext,
  candidatePath: string,
  canonicalPath: string,
): Promise<void> {
  if (candidatePath === canonicalPath) return;

  const result = await runner.run(
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    { cwd: path.dirname(canonicalPath) },
  );
  if (result.exitCode !== 0) {
    throw new OperationalError("could not verify the repository behind the target symlink");
  }
  const discoveredRoot = path.resolve(result.stdout.toString("utf8").trim());
  if (discoveredRoot !== context.worktreeRoot) {
    throw new InvalidInputError("target symlink resolves to a different repository");
  }
}

function repositoryPathFor(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (!isWithinDirectory(root, absolutePath) || relative.length === 0) {
    throw new InvalidInputError("target path is outside the selected worktree");
  }
  return relative.split(path.sep).join("/");
}

async function resolveCanonicalPath(
  context: RepositoryContext,
  candidatePath: string,
  runner: GitRunner,
): Promise<string> {
  const candidateIsWithin = isWithinDirectory(context.worktreeRoot, candidatePath);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(path.dirname(candidatePath));
  } catch {
    if (!candidateIsWithin) {
      throw new InvalidInputError("target path is outside the selected worktree");
    }
    throw new InvalidInputError("target file does not exist");
  }
  // macOS exposes some temporary paths through a lexical alias (for example
  // /var -> /private/var). Compare the canonical parent as well so an
  // equivalent path to this worktree is accepted without allowing an outside
  // directory symlink to smuggle a target into it.
  if (!candidateIsWithin && !isWithinDirectory(context.worktreeRoot, canonicalParent)) {
    throw new InvalidInputError("target path is outside the selected worktree");
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidatePath);
  } catch {
    throw new InvalidInputError("target file does not exist");
  }
  if (!isWithinDirectory(context.worktreeRoot, canonicalPath)) {
    throw new InvalidInputError("target symlink resolves outside the selected worktree");
  }
  await rejectRepositorySwitchThroughSymlink(runner, context, candidatePath, canonicalPath);
  return canonicalPath;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ino === right.ino
    && left.dev === right.dev
    && left.digest === right.digest;
}

export interface CurrentSourceSnapshot {
  readonly absolutePath: string;
  readonly repositoryPath: string;
  readonly text: string;
  readonly lines: readonly string[];
  readonly fileSnapshot: FileSnapshot;
  readonly targetState: TargetStatus["state"];
  readonly targetDirty: boolean;
}

export async function resolveCurrentSource(
  file: string,
  context: RepositoryContext,
  runner: GitRunner,
  currentDirectory: string,
): Promise<CurrentSourceSnapshot> {
  const candidatePath = path.isAbsolute(file)
    ? path.normalize(file)
    : path.resolve(currentDirectory, file);
  const canonicalPath = await resolveCanonicalPath(context, candidatePath, runner);
  const repositoryPath = repositoryPathFor(context.worktreeRoot, canonicalPath);
  const source = await readSnapshot(canonicalPath);
  const text = decodeText(source.bytes);
  const lines = splitTextLines(text);
  const status = await readTargetStatus(runner, context, repositoryPath);
  return {
    absolutePath: canonicalPath,
    repositoryPath,
    text,
    lines,
    fileSnapshot: source.snapshot,
    targetState: status.state,
    targetDirty: status.dirty,
  };
}

export function resolvedRangeLocationFromSource(
  parsed: RangeLocationQuery,
  source: CurrentSourceSnapshot,
): ResolvedRangeCodeLocation {
  const lineCount = parsed.endLine - parsed.startLine + 1;
  if (lineCount > MAX_RANGE_LINES) {
    throw new InvalidInputError("range cannot exceed " + MAX_RANGE_LINES + " lines");
  }
  const first = source.lines[parsed.startLine - 1];
  const last = source.lines[parsed.endLine - 1];
  if (first === undefined || last === undefined) {
    throw new InvalidInputError("range endpoint is beyond end of file");
  }

  const lineContents = source.lines
    .slice(parsed.startLine - 1, parsed.endLine)
    .map(safeLineContent);
  const lineDigests = source.lines
    .slice(parsed.startLine - 1, parsed.endLine)
    .map((line) => digest(Buffer.from(line, "utf8")));
  return {
    input: parsed.input,
    absolutePath: source.absolutePath,
    repositoryPath: source.repositoryPath,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    lineContents,
    lineDigests,
    fileSnapshot: source.fileSnapshot,
    targetState: source.targetState,
    targetDirty: source.targetDirty,
  };
}

export function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameSnapshot(left, right);
}

export function resolvedCodeLocationFromSource(
  parsed: ParsedLocation,
  source: CurrentSourceSnapshot,
): ResolvedCodeLocation {
  const lineContent = source.lines[parsed.line - 1];
  if (lineContent === undefined) {
    throw new InvalidInputError("line is beyond end of file");
  }
  return {
    input: parsed.input,
    absolutePath: source.absolutePath,
    repositoryPath: source.repositoryPath,
    requestedLine: parsed.line,
    lineContent: safeLineContent(lineContent),
    lineDigest: digest(Buffer.from(lineContent, "utf8")),
    fileSnapshot: source.fileSnapshot,
    targetState: source.targetState,
    targetDirty: source.targetDirty,
  };
}

export async function resolveLocation(
  parsed: ParsedLocation,
  context: RepositoryContext,
  runner: GitRunner,
  currentDirectory: string,
): Promise<ResolvedCodeLocation> {
  const source = await resolveCurrentSource(parsed.file, context, runner, currentDirectory);
  return resolvedCodeLocationFromSource(parsed, source);
}

export async function resolveRangeLocation(
  parsed: RangeLocationQuery,
  context: RepositoryContext,
  runner: GitRunner,
  currentDirectory: string,
): Promise<ResolvedRangeCodeLocation> {
  const source = await resolveCurrentSource(parsed.file, context, runner, currentDirectory);
  return resolvedRangeLocationFromSource(parsed, source);
}

export async function currentLocationSnapshot(
  location: Pick<CodeLocation, "absolutePath">,
): Promise<FileSnapshot> {
  const current = await readSnapshot(location.absolutePath);
  return current.snapshot;
}
