import { isDistinctiveLine } from "../agents/codex/safe.js";
import type { ExactBlockInput, ExactBlockProof } from "./model.js";

const MAX_EXACT_BLOCK_LINES = 32;

function alphanumericCount(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + (line.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
}

function distinctiveLineCount(lines: readonly string[]): number {
  return new Set(lines.filter(isDistinctiveLine)).size;
}

export function proveExactBlock(input: ExactBlockInput): ExactBlockProof | null {
  if (!input.currentComplete || !input.ancestorComplete) return null;

  const currentIndex = input.currentLine - 1;
  const ancestorIndex = input.ancestorLine - 1;
  if (
    currentIndex < 0
    || ancestorIndex < 0
    || currentIndex >= input.currentLines.length
    || ancestorIndex >= input.ancestorLines.length
    || input.currentLines[currentIndex] !== input.ancestorLines[ancestorIndex]
  ) {
    return null;
  }

  let currentStart = currentIndex;
  let ancestorStart = ancestorIndex;
  let matchedLineCount = 1;

  while (
    matchedLineCount < MAX_EXACT_BLOCK_LINES
    && currentStart > 0
    && ancestorStart > 0
    && input.currentLines[currentStart - 1] === input.ancestorLines[ancestorStart - 1]
  ) {
    currentStart -= 1;
    ancestorStart -= 1;
    matchedLineCount += 1;
  }

  let currentEnd = currentIndex;
  let ancestorEnd = ancestorIndex;
  while (
    matchedLineCount < MAX_EXACT_BLOCK_LINES
    && currentEnd + 1 < input.currentLines.length
    && ancestorEnd + 1 < input.ancestorLines.length
    && input.currentLines[currentEnd + 1] === input.ancestorLines[ancestorEnd + 1]
  ) {
    currentEnd += 1;
    ancestorEnd += 1;
    matchedLineCount += 1;
  }

  const lines = input.currentLines.slice(currentStart, currentEnd + 1);
  const distinctive = distinctiveLineCount(lines);
  const alphanumeric = alphanumericCount(lines);
  if (distinctive < 2 || alphanumeric < 40) return null;

  return {
    basis: "derived",
    currentStartLine: currentStart + 1,
    ancestorStartLine: ancestorStart + 1,
    matchedLineCount,
    distinctiveLineCount: distinctive,
    alphanumericCount: alphanumeric,
    comparison: "exact-lines",
  };
}
