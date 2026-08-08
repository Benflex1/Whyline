import type {
  AgentDiagnostic,
  AgentEvidence,
  AgentEvidenceBundle,
  AgentPatchChange,
} from "../agents/agent-history-source.js";
import {
  comparePatchChangeToHunks,
  hasCompetingStructuredDivergence,
  type PatchOverlap,
} from "./patch-overlap.js";
import type {
  CorrelationCandidate,
  CorrelationCandidateInput,
  CorrelationLimitation,
  CorrelationSignal,
  CorrelationTarget,
} from "./model.js";

export const CORRELATION_WEIGHTS = {
  sessionHeadTargetReference: 2,
  producedTargetCommitReference: 10,
  structuredPatchOverlap: 8,
  exactCurrentWorktree: 5,
  linkedWorktreeCommonDirectory: 4,
  structuredPatchTargetPath: 4,
  changedPathOverlap: 3,
  structuredPatchAttemptTargetPath: 1,
  temporalProximityDay: 1,
  temporalProximityHour: 2,
  structuredContentDivergence: -5,
} as const;

interface PatchRecord {
  readonly evidence: AgentEvidence;
  readonly change: AgentPatchChange;
}

function signal(
  kind: CorrelationSignal["kind"],
  weight: number,
  basis: CorrelationSignal["basis"],
  evidenceIds: readonly string[],
): CorrelationSignal {
  return { kind, weight, basis, evidenceIds };
}

function targetRelatedPaths(target: CorrelationTarget): ReadonlySet<string> {
  const paths = new Set<string>();
  const add = (value: string | null): void => {
    if (value !== null) paths.add(value);
  };
  add(target.targetPath);
  add(target.blamedPath);

  let changed = true;
  while (changed) {
    changed = false;
    for (const value of target.changedPaths) {
      if ((value.oldPath !== null && paths.has(value.oldPath))
        || (value.newPath !== null && paths.has(value.newPath))) {
        const before = paths.size;
        add(value.oldPath);
        add(value.newPath);
        changed = paths.size !== before || changed;
      }
    }
  }
  return paths;
}

function changedCommitPaths(target: CorrelationTarget): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const changedPath of target.changedPaths) {
    if (changedPath.oldPath !== null) paths.add(changedPath.oldPath);
    if (changedPath.newPath !== null) paths.add(changedPath.newPath);
  }
  return paths;
}

function changePaths(change: AgentPatchChange): readonly string[] {
  return change.movedFrom === undefined
    ? [change.path]
    : [change.path, change.movedFrom];
}

function patchRecords(bundle: AgentEvidenceBundle | null): readonly PatchRecord[] {
  if (bundle === null) return [];
  const records: PatchRecord[] = [];
  for (const evidence of bundle.evidence) {
    if (evidence.kind !== "patch-result" || evidence.patch === undefined) continue;
    const successful = evidence.resultRecorded === true
      && (evidence.reportedSuccess === true || evidence.patch.reportedSuccess === true);
    if (!successful) continue;
    for (const change of evidence.patch.changes) {
      records.push({ evidence, change });
    }
  }
  return records.sort((left, right) => left.evidence.sourceRecord - right.evidence.sourceRecord);
}

function patchAttemptMatchesTarget(
  targetPaths: ReadonlySet<string>,
  evidence: AgentEvidence,
): boolean {
  return evidence.operation === "patch"
    && evidence.paths.some((pathValue) => targetPaths.has(pathValue));
}

function hasTargetReference(
  input: CorrelationCandidateInput,
  kind: "session-head" | "produced-commit",
): boolean {
  return input.references.some((reference) =>
    reference.kind === kind && reference.resolution === "target");
}

function hasHistoricalReference(input: CorrelationCandidateInput): boolean {
  return input.references.some((reference) =>
    reference.kind === "session-head"
      && reference.resolution === "other");
}

function temporalDistanceMs(
  target: CorrelationTarget,
  input: CorrelationCandidateInput,
): number | null {
  const sessionTimes = [input.session.startedAt, input.session.observedThroughAt]
    .filter((value): value is string => value !== undefined)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  const targetTimes = [target.commit.authoredAt, target.commit.committedAt]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (sessionTimes.length === 0 || targetTimes.length === 0) return null;

  const sessionStart = Math.min(...sessionTimes);
  const sessionEnd = Math.max(...sessionTimes);
  let distance = Number.POSITIVE_INFINITY;
  for (const targetTime of targetTimes) {
    const intervalDistance = targetTime < sessionStart
      ? sessionStart - targetTime
      : targetTime > sessionEnd
        ? targetTime - sessionEnd
        : 0;
    distance = Math.min(distance, intervalDistance);
  }
  return Number.isFinite(distance) ? distance : null;
}

function diagnosticLimitation(
  diagnostic: AgentDiagnostic,
  directRecordNumbers: readonly number[],
): CorrelationLimitation | null {
  const record = diagnostic.record;
  const compactionMaterial = record === undefined
    || directRecordNumbers.length === 0
    || record >= Math.max(...directRecordNumbers);

  switch (diagnostic.kind) {
    case "changed-during-read":
      return { kind: "changed-during-read", material: true };
    case "corrupt-non-final-record":
    case "unreadable-transcript":
    case "partial-final-record":
      return { kind: "corrupt-transcript", material: true };
    case "compacted-history":
    case "context-compaction":
      return { kind: "material-compaction", material: compactionMaterial };
    case "thread-rollback":
    case "turn-aborted":
      return {
        kind: "material-rollback-or-abort",
        material: record === undefined
          || directRecordNumbers.length === 0
          || record >= Math.max(...directRecordNumbers),
      };
    case "retention-limit":
      return { kind: "summary-coverage", material: true };
    case "unlinked-tool-result":
      return { kind: "summary-coverage", material: true };
    case "conflicting-session-metadata":
      return { kind: "summary-coverage", material: true };
    default:
      return null;
  }
}

function candidateLimitations(
  target: CorrelationTarget,
  input: CorrelationCandidateInput,
  records: readonly PatchRecord[],
  directRecordNumbers: readonly number[],
): readonly CorrelationLimitation[] {
  let limitations = [...input.coverageLimitations];
  const add = (limitation: CorrelationLimitation): void => {
    if (!limitations.some((value) => value.kind === limitation.kind)) {
      limitations.push(limitation);
    }
  };

  if (target.relevantHunks.some((hunk) => hunk.truncated)) {
    add({ kind: "truncated-git-hunk", material: true });
  }
  for (const record of records) {
    if (record.change.payloadTruncated) {
      const overlap = comparePatchChangeToHunks(target, record.change);
      if (overlap.pathMatched) add({ kind: "truncated-patch-payload", material: true });
    }
  }

  const diagnostics = [
    ...input.session.diagnostics,
    ...(input.evidence?.diagnostics ?? []),
  ];
  const hasExplicitPartialDiagnostic = diagnostics.some((diagnostic) =>
    diagnostic.kind === "partial-final-record"
      || diagnostic.kind === "corrupt-non-final-record"
      || diagnostic.kind === "unreadable-transcript");
  if (input.session.isPartial && !hasExplicitPartialDiagnostic
    && !diagnostics.some((diagnostic) =>
      diagnostic.kind === "compacted-history"
        || diagnostic.kind === "context-compaction"
        || diagnostic.kind === "thread-rollback"
        || diagnostic.kind === "turn-aborted")) {
    add({ kind: "partial-transcript", material: true });
  }
  for (const diagnostic of diagnostics) {
    const limitation = diagnosticLimitation(diagnostic, directRecordNumbers);
    if (limitation !== null) add(limitation);
  }
  return limitations;
}

function overlapSignals(
  target: CorrelationTarget,
  records: readonly PatchRecord[],
): {
  readonly signals: readonly CorrelationSignal[];
  readonly directRecords: readonly PatchRecord[];
} {
  const directRecords: PatchRecord[] = [];
  let targetPathMatched = false;
  let changedPathMatched = false;
  const directEvidenceIds: string[] = [];
  const targetPathEvidenceIds: string[] = [];
  const changedPathEvidenceIds: string[] = [];
  const changedPaths = changedCommitPaths(target);

  for (const record of records) {
    const overlap: PatchOverlap = comparePatchChangeToHunks(target, record.change);
    if (overlap.direct) {
      directRecords.push(record);
      directEvidenceIds.push(record.evidence.id);
    }
    if (!overlap.operationCompatible || !record.change.payloadRecovered
      || record.change.payloadTruncated) continue;
    if (overlap.pathMatched) {
      targetPathMatched = true;
      targetPathEvidenceIds.push(record.evidence.id);
    }
    if (changePaths(record.change).some((pathValue) => changedPaths.has(pathValue))) {
      changedPathMatched = true;
      changedPathEvidenceIds.push(record.evidence.id);
    }
  }

  const signals: CorrelationSignal[] = [];
  if (directRecords.length > 0) {
    signals.push(signal(
      "structured-patch-overlap",
      CORRELATION_WEIGHTS.structuredPatchOverlap,
      "derived",
      [...new Set(directEvidenceIds)],
    ));
  }
  if (targetPathMatched) {
    signals.push(signal(
      "structured-patch-target-path",
      CORRELATION_WEIGHTS.structuredPatchTargetPath,
      "derived",
      [...new Set(targetPathEvidenceIds)],
    ));
  }
  if (changedPathMatched) {
    signals.push(signal(
      "changed-path-overlap",
      CORRELATION_WEIGHTS.changedPathOverlap,
      "derived",
      [...new Set(changedPathEvidenceIds)],
    ));
  }
  return { signals, directRecords };
}

function addPatchAttemptSignal(
  input: CorrelationCandidateInput,
  target: CorrelationTarget,
): CorrelationSignal | null {
  const evidenceIds = (input.evidence?.evidence ?? [])
    .filter((evidence) => {
      if (evidence.kind === "patch-attempt") {
        return patchAttemptMatchesTarget(targetRelatedPaths(target), evidence);
      }
      if (evidence.kind !== "patch-result" || !patchAttemptMatchesTarget(targetRelatedPaths(target), evidence)) {
        return false;
      }
      const reportedSuccess = evidence.resultRecorded === true
        && (evidence.reportedSuccess === true || evidence.patch?.reportedSuccess === true);
      const hasRecoveredTargetChange = reportedSuccess
        && evidence.patch?.changes.some((change) => {
          const overlap = comparePatchChangeToHunks(target, change);
          return change.payloadRecovered && !change.payloadTruncated
            && overlap.operationCompatible && overlap.pathMatched;
        }) === true;
      return !hasRecoveredTargetChange;
    })
    .map((evidence) => evidence.id);
  return evidenceIds.length === 0
    ? null
    : signal(
      "structured-patch-attempt-target-path",
      CORRELATION_WEIGHTS.structuredPatchAttemptTargetPath,
      "fact",
      [...new Set(evidenceIds)],
    );
}

function supportFamilies(signals: readonly CorrelationSignal[]): ReadonlySet<string> {
  const families = new Set<string>();
  for (const current of signals) {
    switch (current.kind) {
      case "exact-current-worktree":
      case "linked-worktree-common-directory":
        families.add("repository");
        break;
      case "session-head-target-reference":
      case "produced-target-commit-reference":
        families.add("reference");
        break;
      case "structured-patch-overlap":
      case "structured-patch-target-path":
      case "changed-path-overlap":
        families.add("structured-patch");
        break;
      case "temporal-proximity":
        families.add("temporal");
        break;
      default:
        break;
    }
  }
  return families;
}

function hasQualifiedPatchSignal(signals: readonly CorrelationSignal[]): boolean {
  return signals.some((current) =>
    current.kind === "structured-patch-target-path"
      || current.kind === "changed-path-overlap");
}

function confidenceBand(
  input: CorrelationCandidateInput,
  signals: readonly CorrelationSignal[],
  contradictions: readonly CorrelationSignal[],
  directOverlap: boolean,
): CorrelationCandidate["band"] {
  if (!input.eligible) return "weak";

  const credibleRepository = input.repositoryMatch === "current-worktree"
    || input.repositoryMatch === "linked-worktree"
    || input.repositoryMatch === "same-common-directory";
  const historicalContext = input.repositoryMatch === "historical-commit-anchored"
    || input.repositoryMatch === "unknown";
  const anchored = hasTargetReference(input, "session-head")
    || hasTargetReference(input, "produced-commit");
  const noDivergence = contradictions.length === 0;

  if (directOverlap && noDivergence
    && (credibleRepository || (historicalContext && anchored))) {
    return "strong";
  }

  if (!credibleRepository) return "weak";

  const families = supportFamilies(signals);
  return families.size >= 2 && hasQualifiedPatchSignal(signals)
    ? "plausible"
    : "weak";
}

export function scoreCandidate(
  target: CorrelationTarget,
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
      coverage: input.coverageLimitations.some((limitation) => limitation.material)
        ? "limited"
        : "complete",
      coverageLimitations: input.coverageLimitations,
    };
  }

  const signals: CorrelationSignal[] = [];
  const contradictions: CorrelationSignal[] = [];
  const addSignal = (value: CorrelationSignal): void => { signals.push(value); };

  if (hasTargetReference(input, "session-head")) {
    addSignal(signal(
      "session-head-target-reference",
      CORRELATION_WEIGHTS.sessionHeadTargetReference,
      "derived",
      ["session-head-reference"],
    ));
  }
  if (hasTargetReference(input, "produced-commit")) {
    addSignal(signal(
      "produced-target-commit-reference",
      CORRELATION_WEIGHTS.producedTargetCommitReference,
      "derived",
      ["produced-commit-reference"],
    ));
  }
  if (hasHistoricalReference(input)) {
    addSignal(signal("historical-commit-reference", 0, "derived", ["historical-commit-reference"]));
  }

  switch (input.repositoryMatch) {
    case "current-worktree":
      addSignal(signal("exact-current-worktree", CORRELATION_WEIGHTS.exactCurrentWorktree, "fact", ["repository-match"]));
      break;
    case "linked-worktree":
    case "same-common-directory":
      addSignal(signal("linked-worktree-common-directory", CORRELATION_WEIGHTS.linkedWorktreeCommonDirectory, "fact", ["repository-match"]));
      break;
    default:
      break;
  }

  const records = patchRecords(input.evidence);
  const overlap = overlapSignals(target, records);
  signals.push(...overlap.signals);

  const attemptSignal = addPatchAttemptSignal(input, target);
  if (attemptSignal !== null) addSignal(attemptSignal);

  const distance = temporalDistanceMs(target, input);
  if (distance !== null && distance <= 24 * 60 * 60 * 1000) {
    addSignal(signal("temporal-proximity", CORRELATION_WEIGHTS.temporalProximityHour, "derived", ["temporal-proximity"]));
  } else if (distance !== null && distance <= 7 * 24 * 60 * 60 * 1000) {
    addSignal(signal("temporal-proximity", CORRELATION_WEIGHTS.temporalProximityDay, "derived", ["temporal-proximity"]));
  }

  if (hasCompetingStructuredDivergence(target, records.map((record) => record.change))) {
    contradictions.push(signal(
      "structured-content-divergence",
      CORRELATION_WEIGHTS.structuredContentDivergence,
      "inferred",
      [...new Set(records.map((record) => record.evidence.id))],
    ));
  }

  const directRecordNumbers = overlap.directRecords.map((record) => record.evidence.sourceRecord);
  const coverageLimitations = candidateLimitations(target, input, records, directRecordNumbers);
  const score = [...signals, ...contradictions]
    .reduce((total, current) => total + current.weight, 0);
  const band = confidenceBand(input, signals, contradictions, overlap.directRecords.length > 0);

  return {
    session: input.session,
    eligible: input.eligible,
    repositoryMatch: input.repositoryMatch,
    score,
    signals,
    contradictions,
    band,
    coverage: coverageLimitations.some((limitation) => limitation.material) ? "limited" : "complete",
    coverageLimitations,
  };
}
