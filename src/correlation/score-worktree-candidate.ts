import type {
  AgentEvidence,
  AgentEvidenceBundle,
  AgentPatchChange,
  AgentPatchHunkEvidence,
} from "../agents/agent-history-source.js";
import type {
  CorrelationCandidate,
  CorrelationCandidateInput,
  CorrelationLimitation,
  CorrelationSignal,
  WorktreeCorrelationTarget,
} from "./model.js";
import {
  proveWorktreeOverlap,
  type WorktreeOverlapResult,
} from "./worktree-overlap.js";

const WORKTREE_WEIGHTS = {
  exactCurrentWorktree: 5,
  structuredPatchTargetPath: 4,
  structuredPatchOverlap: 8,
  structuredContentDivergence: -5,
} as const;

interface PatchRecord {
  readonly evidence: AgentEvidence;
  readonly change: AgentPatchChange;
}

interface ClassifiedRecord extends PatchRecord {
  readonly hunk: AgentPatchHunkEvidence | null;
  readonly localHunkCount: number;
  readonly proof: WorktreeOverlapResult;
  readonly completeLocal: boolean;
  readonly currentPathOperation: boolean;
}

function signal(
  kind: CorrelationSignal["kind"],
  weight: number,
  basis: CorrelationSignal["basis"],
  evidenceIds: readonly string[],
): CorrelationSignal {
  return { kind, weight, basis, evidenceIds };
}

function successfulPatchRecords(bundle: AgentEvidenceBundle | null): readonly PatchRecord[] {
  if (bundle === null) return [];
  const records: PatchRecord[] = [];
  for (const evidence of bundle.evidence) {
    if (evidence.kind !== "patch-result" || evidence.patch === undefined) continue;
    if (evidence.resultRecorded !== true
      || (evidence.reportedSuccess !== true && evidence.patch.reportedSuccess !== true)) continue;
    for (const change of evidence.patch.changes) records.push({ evidence, change });
  }
  return records.sort((left, right) => left.evidence.sourceRecord - right.evidence.sourceRecord);
}

function supportedCurrentOperation(
  target: WorktreeCorrelationTarget,
  change: AgentPatchChange,
): boolean {
  if (!change.payloadRecovered || change.payloadTruncated || change.path !== target.targetPath) return false;
  if (target.changeKind === "modified") {
    return change.changeType === "update"
      && change.payloadKind === "unified-diff"
      && change.matchSide === "added";
  }
  return (change.changeType === "add" && change.payloadKind === "content" && change.matchSide === "content")
    || (change.changeType === "update" && change.payloadKind === "unified-diff" && change.matchSide === "added");
}

function hunkComplete(
  target: WorktreeCorrelationTarget,
  change: AgentPatchChange,
  hunk: AgentPatchHunkEvidence | undefined,
): boolean {
  const targetHunk = target.relevantHunks[0];
  return targetHunk?.complete === true
    && targetHunk.currentLineFingerprints.length === targetHunk.currentLineAlphanumericCounts.length
    && targetHunk.currentLineFingerprints.length <= 32
    && change.payloadRecovered
    && !change.payloadTruncated
    && hunk !== undefined
    && !hunk.truncated
    && hunk.lineCount === hunk.orderedLineFingerprints.length
    && hunk.lineCount <= 32;
}

function sameRegion(
  target: WorktreeCorrelationTarget,
  hunk: AgentPatchHunkEvidence,
): boolean {
  const targetHunk = target.relevantHunks[0];
  if (targetHunk === undefined) return false;
  const targetStart = targetHunk.newStart;
  const targetEnd = targetStart + Math.max(targetHunk.newLines, 1) - 1;
  const patchStart = hunk.newStart;
  const patchEnd = patchStart + Math.max(hunk.newLines, 1) - 1;
  return patchStart <= targetEnd && targetStart <= patchEnd;
}

function distinctiveMaterial(
  target: WorktreeCorrelationTarget,
  hunk: AgentPatchHunkEvidence,
): boolean {
  const targetHunk = target.relevantHunks[0];
  if (targetHunk === undefined || hunk.lineCount > 32) return false;
  if (hunk.orderedLineFingerprints.length === targetHunk.currentLineFingerprints.length
    && hunk.orderedLineFingerprints.every((value, index) =>
      value === targetHunk.currentLineFingerprints[index])) {
    return false;
  }
  const targetDistinctive = new Set(targetHunk.currentDistinctiveLineFingerprints);
  const distinctive = new Set(
    hunk.orderedLineFingerprints.filter((value) => targetDistinctive.has(value)),
  ).size;
  const alphanumeric = targetHunk.currentLineAlphanumericCounts.reduce(
    (total, value) => total + value,
    0,
  );
  return distinctive >= 2 && alphanumeric >= 40;
}

function limitationsFor(
  target: WorktreeCorrelationTarget,
  input: CorrelationCandidateInput,
  records: readonly ClassifiedRecord[],
): readonly CorrelationLimitation[] {
  const limitations = [...input.coverageLimitations];
  const add = (value: CorrelationLimitation): void => {
    if (!limitations.some((current) => current.kind === value.kind)) limitations.push(value);
  };
  const relevant = records.filter((record) =>
    record.change.path === target.targetPath
      || record.change.movedFrom === target.targetPath);
  for (const record of relevant) {
    if (record.evidence.worktreeIdentity === "unknown"
      || record.evidence.worktreeIdentity === undefined) {
      add({ kind: "summary-coverage", material: true });
    }
    if (record.change.payloadTruncated) add({ kind: "truncated-patch-payload", material: true });
    if (record.change.worktreeHunks === undefined
      || record.change.worktreeHunks.some((hunk) => hunk.truncated)) {
      add({ kind: "summary-coverage", material: true });
    }
  }
  const targetHunk = target.relevantHunks[0];
  if (targetHunk === undefined || targetHunk.complete !== true) {
    add({ kind: "truncated-git-hunk", material: true });
  }
  return limitations;
}

function classifyRecords(
  target: WorktreeCorrelationTarget,
  records: readonly PatchRecord[],
): readonly ClassifiedRecord[] {
  return records.map((record): ClassifiedRecord => {
    const currentPathOperation = record.evidence.worktreeIdentity === "exact-current-worktree"
      && supportedCurrentOperation(target, record.change);
    const hunks = record.change.worktreeHunks ?? [];
    const localHunks = hunks.filter((candidate) => {
      const targetContent = target.changeKind === "added"
        && target.relevantHunks[0]?.operation === "add";
      const sideCompatible = targetContent
        ? candidate.matchSide === "content" || candidate.matchSide === "added"
        : candidate.matchSide === "added";
      return sideCompatible && sameRegion(target, candidate);
    });
    const hunk = localHunks.length === 1 ? localHunks[0] ?? null : null;
    const proof = hunk === null
      ? { status: "insufficient", reason: "hunk-locality-mismatch" } as const
      : proveWorktreeOverlap({ target, change: record.change, patchHunk: hunk });
    return {
      ...record,
      hunk,
      proof,
      localHunkCount: localHunks.length,
      completeLocal: currentPathOperation
        && localHunks.length > 0
        && localHunks.every((candidate) => hunkComplete(target, record.change, candidate)),
      currentPathOperation,
    };
  });
}

function divergenceIds(
  target: WorktreeCorrelationTarget,
  records: readonly ClassifiedRecord[],
): readonly string[] {
  let contradictions: string[] = [];
  for (const record of records) {
    if (!record.completeLocal || record.hunk === null || record.localHunkCount !== 1) continue;
    if (record.proof.status === "exact") {
      contradictions = [];
      continue;
    }
    if (!distinctiveMaterial(target, record.hunk)) continue;
    contradictions.push(record.evidence.id);
  }
  return contradictions;
}

function scoreValue(signals: readonly CorrelationSignal[], contradictions: readonly CorrelationSignal[]): number {
  return [...signals, ...contradictions].reduce((total, current) => total + current.weight, 0);
}

export function scoreWorktreeCandidate(
  target: WorktreeCorrelationTarget,
  input: CorrelationCandidateInput,
): CorrelationCandidate {
  if (!input.eligible || input.repositoryMatch === "incompatible") {
    return {
      session: input.session,
      eligible: false,
      repositoryMatch: input.repositoryMatch,
      score: 0,
      signals: [],
      contradictions: [],
      band: "weak",
      coverage: input.coverageLimitations.some((value) => value.material) ? "limited" : "complete",
      coverageLimitations: input.coverageLimitations,
    };
  }

  const records = classifyRecords(target, successfulPatchRecords(input.evidence));
  const limitations = limitationsFor(target, input, records);
  const exactRecords = records.filter((record) => record.currentPathOperation);
  const directRecords = records.filter((record) =>
    record.currentPathOperation && record.proof.status === "exact");
  const pathRecords = records.filter((record) => record.currentPathOperation
    && record.change.path === target.targetPath);
  const contradictionEvidenceIds = divergenceIds(target, records);
  const signals: CorrelationSignal[] = [];
  const contradictions: CorrelationSignal[] = [];
  if (exactRecords.length > 0) {
    signals.push(signal(
      "exact-current-worktree",
      WORKTREE_WEIGHTS.exactCurrentWorktree,
      "fact",
      [...new Set(exactRecords.map((record) => record.evidence.id))],
    ));
  }
  if (pathRecords.length > 0) {
    signals.push(signal(
      "structured-patch-target-path",
      WORKTREE_WEIGHTS.structuredPatchTargetPath,
      "derived",
      [...new Set(pathRecords.map((record) => record.evidence.id))],
    ));
  }
  if (directRecords.length > 0) {
    signals.push(signal(
      "structured-patch-overlap",
      WORKTREE_WEIGHTS.structuredPatchOverlap,
      "derived",
      [...new Set(directRecords.map((record) => record.evidence.id))],
    ));
  }
  if (contradictionEvidenceIds.length > 0) {
    contradictions.push(signal(
      "structured-content-divergence",
      WORKTREE_WEIGHTS.structuredContentDivergence,
      "inferred",
      [...new Set(contradictionEvidenceIds)],
    ));
  }

  const materialLimitation = limitations.some((value) => value.material);
  const completeSupportedCurrentPath = exactRecords.some((record) =>
    record.completeLocal && record.hunk !== null
      && record.change.path === target.targetPath);
  const strong = directRecords.length > 0
    && directRecords.some((record) => record.completeLocal)
    && directRecords.every((record) => record.localHunkCount === 1)
    && contradictionEvidenceIds.length === 0
    && !materialLimitation;
  const plausible = !strong
    && completeSupportedCurrentPath
    && directRecords.length === 0
    && contradictionEvidenceIds.length === 0
    && !materialLimitation;

  return {
    session: input.session,
    eligible: input.eligible,
    repositoryMatch: input.repositoryMatch,
    score: scoreValue(signals, contradictions),
    signals,
    contradictions,
    band: strong ? "strong" : plausible ? "plausible" : "weak",
    coverage: materialLimitation ? "limited" : "complete",
    coverageLimitations: limitations,
  };
}
