import type { AgentPatchChange, AgentPatchHunkRange } from "../agents/agent-history-source.js";
import type { CorrelationHunk, CorrelationTarget } from "./model.js";

export type PatchOverlapReason =
  | "direct-overlap"
  | "unsupported-combination"
  | "payload-unavailable"
  | "truncated-patch-payload"
  | "path-mismatch"
  | "no-relevant-hunk"
  | "outside-hunk"
  | "insufficient-distinctive-overlap"
  | "truncated-git-hunk";

export interface PatchOverlap {
  readonly direct: boolean;
  readonly pathMatched: boolean;
  readonly operationCompatible: boolean;
  readonly hunkLocal: boolean | null;
  readonly distinctiveIntersectionCount: number;
  readonly reason: PatchOverlapReason;
  readonly unknown: boolean;
}

interface HunkMatch {
  readonly hunk: CorrelationHunk;
  readonly fingerprintSet: ReadonlySet<string>;
}

function changePaths(change: AgentPatchChange): readonly string[] {
  return change.movedFrom === undefined ? [change.path] : [change.path, change.movedFrom];
}

function targetPaths(target: CorrelationTarget): ReadonlySet<string> {
  const paths = new Set<string>([target.targetPath]);
  if (target.blamedPath !== null) {
    paths.add(target.blamedPath);
  }
  for (const changedPath of target.changedPaths) {
    if (changedPath.oldPath !== null) paths.add(changedPath.oldPath);
    if (changedPath.newPath !== null) paths.add(changedPath.newPath);
  }
  return paths;
}

function supportedOperation(change: AgentPatchChange): boolean {
  return (change.changeType === "update"
    && change.payloadKind === "unified-diff"
    && change.matchSide === "added")
    || (change.changeType === "add"
      && change.payloadKind === "content"
      && change.matchSide === "content")
    || (change.changeType === "delete"
      && change.payloadKind === "content"
      && change.matchSide === "deleted");
}

function hunkSharesPath(
  hunk: CorrelationHunk,
  paths: ReadonlySet<string>,
): boolean {
  const hunkPaths = [hunk.oldPath, hunk.newPath].filter(
    (value): value is string => value !== null,
  );
  return hunkPaths.length === 0 || hunkPaths.some((value) => paths.has(value));
}

function distinctiveFingerprints(
  hunk: CorrelationHunk,
  side: AgentPatchChange["matchSide"],
): readonly string[] {
  return side === "deleted"
    ? hunk.distinctiveDeletedLineFingerprints
    : hunk.distinctiveAddedLineFingerprints;
}

function rangesOverlap(
  left: AgentPatchHunkRange,
  right: Pick<CorrelationHunk, "oldStart" | "oldLines" | "newStart" | "newLines">,
  side: "old" | "new",
): boolean {
  const leftStart = side === "old" ? left.oldStart : left.newStart;
  const leftLines = side === "old" ? left.oldLines : left.newLines;
  const rightStart = side === "old" ? right.oldStart : right.newStart;
  const rightLines = side === "old" ? right.oldLines : right.newLines;
  const leftEnd = leftStart + Math.max(leftLines, 1) - 1;
  const rightEnd = rightStart + Math.max(rightLines, 1) - 1;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function hunkLocal(
  change: AgentPatchChange,
  hunkMatches: readonly HunkMatch[],
): boolean | null {
  if (change.matchSide !== "added" || change.hunkRanges.length === 0) {
    return change.matchSide === "added" ? false : null;
  }
  return hunkMatches.some(({ hunk }) => change.hunkRanges.some((range) =>
    rangesOverlap(range, hunk, "new")));
}

function intersectionCount(
  change: AgentPatchChange,
  hunkMatches: readonly HunkMatch[],
): number {
  const intersection = new Set<string>();
  for (const fingerprint of change.distinctiveLineFingerprints) {
    if (hunkMatches.some(({ fingerprintSet }) => fingerprintSet.has(fingerprint))) {
      intersection.add(fingerprint);
    }
  }
  return intersection.size;
}

function result(
  values: Omit<PatchOverlap, "direct" | "unknown"> & { readonly direct: boolean; readonly unknown?: boolean },
): PatchOverlap {
  return {
    ...values,
    unknown: values.unknown ?? false,
  };
}

export function comparePatchChangeToHunks(
  target: CorrelationTarget,
  change: AgentPatchChange,
): PatchOverlap {
  const operationCompatible = supportedOperation(change);
  if (!operationCompatible) {
    return result({
      direct: false,
      pathMatched: false,
      operationCompatible,
      hunkLocal: null,
      distinctiveIntersectionCount: 0,
      reason: "unsupported-combination",
    });
  }

  const acceptedPaths = targetPaths(target);
  const patchPaths = changePaths(change);
  const pathMatched = patchPaths.some((value) => acceptedPaths.has(value));
  if (!pathMatched) {
    return result({
      direct: false,
      pathMatched,
      operationCompatible,
      hunkLocal: null,
      distinctiveIntersectionCount: 0,
      reason: "path-mismatch",
    });
  }

  if (!change.payloadRecovered) {
    return result({
      direct: false,
      pathMatched,
      operationCompatible,
      hunkLocal: null,
      distinctiveIntersectionCount: 0,
      reason: "payload-unavailable",
    });
  }

  const hunkMatches = target.relevantHunks
    .filter((hunkValue) => hunkSharesPath(hunkValue, acceptedPaths))
    .map((hunkValue) => ({
      hunk: hunkValue,
      fingerprintSet: new Set(distinctiveFingerprints(hunkValue, change.matchSide)),
    }));
  if (hunkMatches.length === 0) {
    return result({
      direct: false,
      pathMatched,
      operationCompatible,
      hunkLocal: null,
      distinctiveIntersectionCount: 0,
      reason: "no-relevant-hunk",
    });
  }

  const distinctiveIntersectionCount = intersectionCount(change, hunkMatches);
  const locality = hunkLocal(change, hunkMatches);
  if (change.payloadTruncated) {
    return result({
      direct: false,
      pathMatched,
      operationCompatible,
      hunkLocal: locality,
      distinctiveIntersectionCount,
      reason: "truncated-patch-payload",
      unknown: true,
    });
  }

  const direct = distinctiveIntersectionCount >= 2
    && (locality === null || locality);
  if (direct) {
    return result({
      direct,
      pathMatched,
      operationCompatible,
      hunkLocal: locality,
      distinctiveIntersectionCount,
      reason: "direct-overlap",
    });
  }

  if (target.relevantHunks.some(({ truncated }) => truncated)) {
    return result({
      direct: false,
      pathMatched,
      operationCompatible,
      hunkLocal: locality,
      distinctiveIntersectionCount,
      reason: "truncated-git-hunk",
      unknown: true,
    });
  }

  return result({
    direct: false,
    pathMatched,
    operationCompatible,
    hunkLocal: locality,
    distinctiveIntersectionCount,
    reason: locality === false ? "outside-hunk" : "insufficient-distinctive-overlap",
  });
}

function supportedTargetRelatedChange(
  target: CorrelationTarget,
  change: AgentPatchChange,
): boolean {
  return supportedOperation(change)
    && change.payloadRecovered
    && !change.payloadTruncated
    && comparePatchChangeToHunks(target, change).pathMatched;
}

function sharesTargetPath(
  target: CorrelationTarget,
  first: AgentPatchChange,
  second: AgentPatchChange,
): boolean {
  const acceptedPaths = targetPaths(target);
  const firstPaths = changePaths(first);
  const secondPaths = new Set(changePaths(second));
  return firstPaths.some((value) => acceptedPaths.has(value) && secondPaths.has(value));
}

export function hasCompetingStructuredDivergence(
  target: CorrelationTarget,
  changes: readonly AgentPatchChange[],
): boolean {
  if (target.relevantHunks.some(({ truncated }) => truncated)) {
    return false;
  }

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (change === undefined || !supportedTargetRelatedChange(target, change)) {
      continue;
    }

    const overlap = comparePatchChangeToHunks(target, change);
    const contentOnly = change.changeType === "add" || change.changeType === "delete";
    if (
      contentOnly
      || overlap.direct
      || new Set(change.distinctiveLineFingerprints).size < 2
      || overlap.hunkLocal !== true
    ) {
      continue;
    }

    const superseded = changes.slice(index + 1).some((later) => {
      const laterOverlap = comparePatchChangeToHunks(target, later);
      return laterOverlap.direct && sharesTargetPath(target, change, later);
    });
    if (!superseded) {
      return true;
    }
  }
  return false;
}
