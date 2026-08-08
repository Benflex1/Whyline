import type { GitRunner } from "./git-process.js";
import {
  decodeGitUtf8,
  requireGitSuccess,
} from "./git-process.js";
import { decodeGitPath } from "./git-path.js";
import type { GitBlameAttribution, RepositoryContext } from "../provenance/model.js";
import { OperationalError } from "../whyline-error.js";

const MAX_RETAINED_LINE_LENGTH = 4096;

function bounded(value: string): string {
  return value.length > MAX_RETAINED_LINE_LENGTH ? value.slice(0, MAX_RETAINED_LINE_LENGTH) : value;
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

function parseHeaderLine(line: string): { readonly objectId: string; readonly originalLine: number; readonly finalLine: number } | null {
  const match = /^(?:\^)?([0-9a-fA-F]+) (\d+) (\d+)(?: \d+)?$/.exec(line);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  const originalLine = Number(match[2]);
  const finalLine = Number(match[3]);
  if (!Number.isSafeInteger(originalLine) || !Number.isSafeInteger(finalLine)) {
    return null;
  }
  return { objectId: match[1], originalLine, finalLine };
}

export function parseBlamePorcelain(value: Buffer, fallbackPath: string): GitBlameAttribution {
  const lines = decodeGitUtf8(value).split("\n");
  const first = lines[0];
  if (first === undefined) {
    throw new OperationalError("Git blame returned no attribution");
  }
  const header = parseHeaderLine(first);
  if (header === null) {
    throw new OperationalError("Git blame returned malformed porcelain output");
  }

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

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.startsWith("\t")) {
      lineContent = bounded(line.slice(1));
      break;
    }

    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const valuePart = separator < 0 ? "" : line.slice(separator + 1);
    switch (key) {
      case "author":
        authorName = valuePart;
        break;
      case "author-mail":
        authorEmail = valuePart;
        break;
      case "author-time":
        authorTime = valuePart;
        break;
      case "author-tz":
        authorTimezone = valuePart;
        break;
      case "committer":
        committerName = valuePart;
        break;
      case "committer-mail":
        committerEmail = valuePart;
        break;
      case "committer-time":
        committerTime = valuePart;
        break;
      case "committer-tz":
        committerTimezone = valuePart;
        break;
      case "previous": {
        const previous = parsePrevious(valuePart);
        previousCommit = previous.commit;
        previousPath = previous.path;
        break;
      }
      case "filename":
        filename = decodeGitPath(valuePart);
        break;
      case "blob":
        blobId = valuePart;
        break;
      default:
        break;
    }
  }

  if (lineContent === null) {
    throw new OperationalError("Git blame returned no attributed line");
  }

  const uncommitted = /^0+$/.test(header.objectId);
  return {
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
}

export async function blameLine(
  runner: GitRunner,
  context: RepositoryContext,
  repositoryPath: string,
  line: number,
): Promise<GitBlameAttribution> {
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
      `${line},${line}`,
      "--",
      repositoryPath,
    ],
    context.worktreeRoot,
    "Git blame",
  );
  return parseBlamePorcelain(result.stdout, repositoryPath);
}
