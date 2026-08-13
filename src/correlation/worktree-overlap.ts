import type { AgentPatchChange } from "../agents/agent-history-source.js";
import type {
  RangeLineSpan,
} from "../provenance/range-model.js";
import type { WorktreeCorrelationTarget } from "./model.js";

export interface WorktreeOverlapInput {
  readonly target: WorktreeCorrelationTarget;
  readonly change: AgentPatchChange;
  readonly patchHunk: WorktreePatchHunkEvidence;
}

export interface WorktreePatchHunkEvidence {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly matchSide: "added" | "content";
  readonly orderedLineFingerprints: readonly string[];
  readonly distinctiveLineFingerprints: readonly string[];
  readonly lineCount: number;
  readonly truncated: boolean;
}

export type WorktreeOverlapResult =
  | {
      readonly status: "exact";
      readonly basis: "derived";
      readonly comparison: "exact-line-fingerprints";
      readonly targetStartLine: number;
      readonly patchStartLine: number;
      readonly matchedLineCount: number;
      readonly distinctiveLineCount: number;
      readonly alphanumericCount: number;
      readonly coveredQuerySpans: readonly RangeLineSpan[];
    }
  | {
      readonly status: "insufficient";
      readonly reason:
        | "query-not-covered"
        | "insufficient-distinctive-material"
        | "ambiguous-exact-alignment"
        | "hunk-locality-mismatch"
        | "operation-mismatch"
        | "path-mismatch";
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "target-incomplete"
        | "patch-incomplete"
        | "fingerprint-coverage-incomplete";
    };

function insufficient(reason: Extract<WorktreeOverlapResult, { readonly status: "insufficient" }>["reason"]): WorktreeOverlapResult {
  return { status: "insufficient", reason };
}

function unavailable(reason: Extract<WorktreeOverlapResult, { readonly status: "unavailable" }>["reason"]): WorktreeOverlapResult {
  return { status: "unavailable", reason };
}

function isModifiedUpdate(change: AgentPatchChange): boolean {
  return change.changeType === "update"
    && change.payloadKind === "unified-diff"
    && change.matchSide === "added";
}

function isAddedContent(change: AgentPatchChange): boolean {
  return change.changeType === "add"
    && change.payloadKind === "content"
    && change.matchSide === "content";
}

function isAddedLaterUpdate(change: AgentPatchChange): boolean {
  return isModifiedUpdate(change);
}

function rangeEnd(start: number, lines: number): number {
  return start + Math.max(lines, 1) - 1;
}

function containsLine(start: number, lines: number, line: number): boolean {
  return line >= start && line <= rangeEnd(start, lines);
}

function spansContain(spans: readonly RangeLineSpan[], line: number): boolean {
  return spans.some((span) => line >= span.startLine && line <= span.endLine);
}

interface Alignment {
  readonly targetStart: number;
  readonly targetEnd: number;
  readonly patchStart: number;
  readonly patchEnd: number;
}

function alignments(
  targetFingerprints: readonly string[],
  patchFingerprints: readonly string[],
  queriedIndexes: readonly number[],
): readonly Alignment[] {
  const results: Alignment[] = [];
  const seen = new Set<string>();
  for (const queriedIndex of queriedIndexes) {
    const queriedFingerprint = targetFingerprints[queriedIndex];
    if (queriedFingerprint === undefined) continue;
    for (let patchIndex = 0; patchIndex < patchFingerprints.length; patchIndex += 1) {
      if (patchFingerprints[patchIndex] !== queriedFingerprint) continue;
      let targetStart = queriedIndex;
      let patchStart = patchIndex;
      let targetEnd = queriedIndex;
      let patchEnd = patchIndex;
      while (
        targetStart > 0
        && patchStart > 0
        && targetFingerprints[targetStart - 1] === patchFingerprints[patchStart - 1]
      ) {
        targetStart -= 1;
        patchStart -= 1;
      }
      while (
        targetEnd + 1 < targetFingerprints.length
        && patchEnd + 1 < patchFingerprints.length
        && targetFingerprints[targetEnd + 1] === patchFingerprints[patchEnd + 1]
      ) {
        targetEnd += 1;
        patchEnd += 1;
      }
      if (!queriedIndexes.every((index) => index >= targetStart && index <= targetEnd)) continue;
      const key = `${targetStart}:${targetEnd}:${patchStart}:${patchEnd}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ targetStart, targetEnd, patchStart, patchEnd });
      }
    }
  }
  return results;
}

function distinctiveCount(
  fingerprints: readonly string[],
  distinctive: readonly string[],
): number {
  const distinctiveSet = new Set(distinctive);
  return new Set(fingerprints.filter((fingerprint) => distinctiveSet.has(fingerprint))).size;
}

export function proveWorktreeOverlap(
  input: WorktreeOverlapInput,
): WorktreeOverlapResult {
  const { target, change, patchHunk } = input;
  const targetHunk = target.relevantHunks[0];
  if (targetHunk === undefined || target.relevantHunks.length !== 1 || targetHunk.complete !== true) {
    return unavailable("target-incomplete");
  }
  if (!change.payloadRecovered || change.payloadTruncated) return unavailable("patch-incomplete");
  if (patchHunk.truncated) return unavailable("fingerprint-coverage-incomplete");
  if (patchHunk.lineCount !== patchHunk.orderedLineFingerprints.length) {
    return unavailable("fingerprint-coverage-incomplete");
  }
  if (targetHunk.currentLineFingerprints.length !== targetHunk.currentLineAlphanumericCounts.length) {
    return unavailable("fingerprint-coverage-incomplete");
  }

  const compatible = target.changeKind === "modified"
    ? isModifiedUpdate(change) && targetHunk.operation === "update" && patchHunk.matchSide === "added"
    : (isAddedContent(change) && targetHunk.operation === "add" && patchHunk.matchSide === "content")
      || (isAddedLaterUpdate(change) && targetHunk.operation === "add" && patchHunk.matchSide === "added");
  if (!compatible) return insufficient("operation-mismatch");
  if (change.path !== target.targetPath) return insufficient("path-mismatch");
  if (change.matchSide !== patchHunk.matchSide) return insufficient("operation-mismatch");

  const querySpans = targetHunk.queriedSpans;
  const queryLines = querySpans.flatMap((span) => {
    const lines: number[] = [];
    for (let line = span.startLine; line <= span.endLine; line += 1) lines.push(line);
    return lines;
  });
  if (queryLines.length === 0 || !queryLines.every((line) => spansContain(querySpans, line))) {
    return insufficient("query-not-covered");
  }

  if (change.changeType === "update") {
    const targetStart = targetHunk.newStart;
    const targetEnd = rangeEnd(targetHunk.newStart, targetHunk.newLines);
    const patchStart = patchHunk.newStart;
    const patchEnd = rangeEnd(patchHunk.newStart, patchHunk.newLines);
    if (patchStart > targetEnd || targetStart > patchEnd) return insufficient("hunk-locality-mismatch");
    if (!queryLines.every((line) => containsLine(patchStart, patchHunk.newLines, line))) {
      return insufficient("hunk-locality-mismatch");
    }
  }

  const targetFingerprints = targetHunk.currentLineFingerprints;
  const queryIndexes = queryLines.map((line) => line - targetHunk.newStart);
  if (queryIndexes.some((index) => index < 0 || index >= targetFingerprints.length)) {
    return insufficient("query-not-covered");
  }
  const candidates = alignments(targetFingerprints, patchHunk.orderedLineFingerprints, queryIndexes);
  if (candidates.length === 0) return insufficient("query-not-covered");
  if (candidates.length !== 1) return insufficient("ambiguous-exact-alignment");
  const alignment = candidates[0] as Alignment;
  const matched = targetFingerprints.slice(alignment.targetStart, alignment.targetEnd + 1);
  if (matched.length > 32) return insufficient("insufficient-distinctive-material");
  const distinctive = distinctiveCount(matched, targetHunk.currentDistinctiveLineFingerprints);
  const alphanumeric = targetHunk.currentLineAlphanumericCounts
    .slice(alignment.targetStart, alignment.targetEnd + 1)
    .reduce((total, count) => total + count, 0);
  if (distinctive < 2 || alphanumeric < 40) return insufficient("insufficient-distinctive-material");
  return {
    status: "exact",
    basis: "derived",
    comparison: "exact-line-fingerprints",
    targetStartLine: targetHunk.newStart + alignment.targetStart,
    patchStartLine: patchHunk.newStart + alignment.patchStart,
    matchedLineCount: matched.length,
    distinctiveLineCount: distinctive,
    alphanumericCount: alphanumeric,
    coveredQuerySpans: querySpans,
  };
}
