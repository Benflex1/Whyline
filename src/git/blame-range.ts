import type {
  GitBlameAttribution,
  RepositoryContext,
} from "../provenance/model.js";
import type { RangeLineAttribution } from "../provenance/range-model.js";
import { OperationalError } from "../whyline-error.js";
import { decodeGitUtf8, requireGitSuccess, type GitRunner } from "./git-process.js";
import { decodeGitPath } from "./git-path.js";

const MAX_RETAINED_LINE_LENGTH = 4096;

interface Header {
  readonly objectId: string;
  readonly originalLine: number;
  readonly finalLine: number;
}

function bounded(value: string): string {
  return value.length > MAX_RETAINED_LINE_LENGTH
    ? value.slice(0, MAX_RETAINED_LINE_LENGTH)
    : value;
}

function parseHeader(value: string): Header {
  const match = /^(?:\^)?([0-9a-fA-F]+) (\d+) (\d+)(?: \d+)?$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new OperationalError("Git blame returned malformed porcelain output");
  }
  const originalLine = Number(match[2]);
  const finalLine = Number(match[3]);
  if (!Number.isSafeInteger(originalLine) || !Number.isSafeInteger(finalLine)) {
    throw new OperationalError("Git blame returned malformed porcelain output");
  }
  return {
    objectId: match[1],
    originalLine,
    finalLine,
  };
}

function parsePrevious(value: string): { readonly commit: string; readonly path: string | null } {
  const separator = value.indexOf(" ");
  if (separator < 1) {
    return { commit: value, path: null };
  }
  return {
    commit: value.slice(0, separator),
    path: decodeGitPath(value.slice(separator + 1)),
  };
}

interface ParsedRecord {
  readonly fact: RangeLineAttribution;
  readonly nextIndex: number;
}

function parseRecord(
  lines: readonly string[],
  index: number,
  fallbackPath: string,
): ParsedRecord {
  const first = lines[index];
  if (first === undefined) {
    throw new OperationalError("Git blame returned no attribution");
  }
  const header = parseHeader(first);
  let authorName: string | null = null;
  let authorEmail: string | null = null;
  let authorTime: string | null = null;
  let authorTimezone: string | null = null;
  let committerName: string | null = null;
  let committerEmail: string | null = null;
  let committerTime: string | null = null;
  let committerTimezone: string | null = null;
  let filename: string | null = null;
  let previousCommit: string | null = null;
  let previousPath: string | null = null;
  let blobId: string | null = null;
  let lineContent: string | null = null;

  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line === undefined) continue;
    if (line.startsWith("\t")) {
      lineContent = bounded(line.slice(1));
      const uncommitted = /^0+$/.test(header.objectId);
      const blame: GitBlameAttribution = {
        basis: "fact",
        objectId: header.objectId,
        uncommitted,
        originalLine: header.originalLine,
        finalLine: header.finalLine,
        authorName,
        authorEmail,
        authorTime,
        authorTimezone,
        committerName,
        committerEmail,
        committerTime,
        committerTimezone,
        filename: filename ?? fallbackPath,
        previousCommit,
        previousPath,
        blobId,
        lineContent,
      };
      return {
        fact: { queryLine: header.finalLine, blame },
        nextIndex: cursor + 1,
      };
    }

    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    switch (key) {
      case "author":
        authorName = value;
        break;
      case "author-mail":
        authorEmail = value;
        break;
      case "author-time":
        authorTime = value;
        break;
      case "author-tz":
        authorTimezone = value;
        break;
      case "committer":
        committerName = value;
        break;
      case "committer-mail":
        committerEmail = value;
        break;
      case "committer-time":
        committerTime = value;
        break;
      case "committer-tz":
        committerTimezone = value;
        break;
      case "previous": {
        const previous = parsePrevious(value);
        previousCommit = previous.commit;
        previousPath = previous.path;
        break;
      }
      case "filename":
        filename = decodeGitPath(value);
        break;
      case "blob":
        blobId = value;
        break;
      default:
        break;
    }
  }

  throw new OperationalError("Git blame returned no attributed line");
}

export function parseBlamePorcelainRange(
  value: Buffer | string,
  fallbackPath: string,
  startLine: number,
  endLine: number,
): readonly RangeLineAttribution[] {
  const lines = (typeof value === "string" ? value : decodeGitUtf8(value)).split("\n");
  const facts: RangeLineAttribution[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index] === "" && index === lines.length - 1) {
      index += 1;
      continue;
    }
    const parsed = parseRecord(lines, index, fallbackPath);
    facts.push(parsed.fact);
    index = parsed.nextIndex;
  }

  const expectedCount = endLine - startLine + 1;
  if (facts.length !== expectedCount) {
    throw new OperationalError("Git blame returned an incomplete range");
  }
  const seen = new Set<number>();
  for (const fact of facts) {
    if (fact.queryLine < startLine || fact.queryLine > endLine || seen.has(fact.queryLine)) {
      throw new OperationalError("Git blame returned malformed range lines");
    }
    seen.add(fact.queryLine);
  }
  for (let line = startLine; line <= endLine; line += 1) {
    if (!seen.has(line)) {
      throw new OperationalError("Git blame returned an incomplete range");
    }
  }
  return [...facts].sort((left, right) => left.queryLine - right.queryLine);
}

export async function blameRange(
  runner: GitRunner,
  context: RepositoryContext,
  repositoryPath: string,
  startLine: number,
  endLine: number,
): Promise<readonly RangeLineAttribution[]> {
  const result = await requireGitSuccess(
    runner,
    [
      "-c",
      "core.quotePath=false",
      "-c",
      "color.ui=false",
      "blame",
      "--line-porcelain",
      "-L",
      startLine + "," + endLine,
      "--",
      repositoryPath,
    ],
    context.worktreeRoot,
    "Git range blame",
  );
  return parseBlamePorcelainRange(result.stdout, repositoryPath, startLine, endLine);
}
