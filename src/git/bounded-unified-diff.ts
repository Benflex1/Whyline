import type {
  GitDiffLine,
  GitDiffLineKind,
  GitHunk,
} from "../provenance/model.js";
import { OperationalError } from "../whyline-error.js";
import { decodeGitUtf8 } from "./git-process.js";
import { decodeGitPath } from "./git-path.js";

export const MAX_RETAINED_DIFF_HUNK_LINES = 256;
export const MAX_RETAINED_DIFF_HUNK_BYTES = 32 * 1024;

interface HunkBuilder {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: GitDiffLine[];
  readonly rawLines: string[];
  rawBytes: number;
  truncated: boolean;
  nextNewLine: number;
  targetLineKind: "added" | "context" | null;
}

function pathFromDiffMarker(value: string, prefix: "a/" | "b/"): string | null {
  const decoded = decodeGitPath(value);
  if (decoded === "/dev/null") return null;
  return decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded;
}

function addHunkLine(
  builder: HunkBuilder,
  line: string,
  targetLines: number | ReadonlySet<number>,
): void {
  const lineBytes = Buffer.byteLength(line, "utf8") + 1;
  if (builder.rawBytes + lineBytes <= MAX_RETAINED_DIFF_HUNK_BYTES) {
    builder.rawLines.push(line);
    builder.rawBytes += lineBytes;
  } else {
    builder.truncated = true;
  }

  let kind: GitDiffLineKind;
  if (line.startsWith("+")) {
    kind = "added";
  } else if (line.startsWith("-")) {
    kind = "deleted";
  } else if (line.startsWith(" ")) {
    kind = "context";
  } else {
    kind = "metadata";
  }

  if (kind === "added" || kind === "context") {
    const targets = typeof targetLines === "number"
      ? builder.nextNewLine === targetLines
      : targetLines.has(builder.nextNewLine);
    if (targets) builder.targetLineKind = kind;
    builder.nextNewLine += 1;
  }
  if (builder.lines.length < MAX_RETAINED_DIFF_HUNK_LINES) {
    builder.lines.push({ kind, text: line.length > 1 ? line.slice(1) : "" });
  } else {
    builder.truncated = true;
  }
}

function finishHunk(builder: HunkBuilder): GitHunk {
  return {
    basis: "derived",
    oldPath: builder.oldPath,
    newPath: builder.newPath,
    oldStart: builder.oldStart,
    oldLines: builder.oldLines,
    newStart: builder.newStart,
    newLines: builder.newLines,
    targetLineKind: builder.targetLineKind,
    lines: [...builder.lines],
    raw: builder.rawLines.join("\n"),
    truncated: builder.truncated,
  };
}

export function parseBoundedUnifiedDiff(
  value: Buffer,
  targetLines: number | ReadonlySet<number>,
): GitHunk[] {
  const lines = decodeGitUtf8(value).split("\n");
  const hunks: GitHunk[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let current: HunkBuilder | null = null;

  const finish = (): void => {
    if (current !== null) {
      hunks.push(finishHunk(current));
      current = null;
    }
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finish();
      oldPath = null;
      newPath = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = pathFromDiffMarker(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = pathFromDiffMarker(line.slice(4), "b/");
      continue;
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match !== null) {
      finish();
      const oldStart = Number(match[1]);
      const oldLines = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newLines = match[4] === undefined ? 1 : Number(match[4]);
      if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger)) {
        throw new OperationalError("Git diff hunk header was malformed");
      }
      current = {
        oldPath,
        newPath,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
        rawLines: [line],
        rawBytes: Buffer.byteLength(line, "utf8") + 1,
        truncated: false,
        nextNewLine: newStart,
        targetLineKind: null,
      };
      continue;
    }

    if (current !== null) addHunkLine(current, line, targetLines);
  }
  finish();
  return hunks;
}

export const parseUnifiedDiff = parseBoundedUnifiedDiff;
