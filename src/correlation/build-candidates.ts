import type {
  AgentCorrelationEvidenceProjection,
  AgentEvidenceBundle,
  AgentPatchChange,
  AgentRelevanceCoverage,
  AgentSessionSummary,
} from "../agents/agent-history-source.js";
import type {
  CannotProveReason,
  CandidateStrongPossibility,
  CorrelationCandidateInput,
  CorrelationLimitation,
  CorrelationRepositoryMatch,
  ResolvedCommitReference,
} from "./model.js";

export interface StrongPossibilityRequest {
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly correlationEvidence: AgentCorrelationEvidenceProjection;
  readonly relevanceCoverage: AgentRelevanceCoverage;
  readonly targetAliases: ReadonlySet<string>;
  readonly pathClassificationComplete?: boolean;
}

function safeNormalizedPath(value: string | undefined): boolean {
  return value !== undefined
    && value.length > 0
    && !value.startsWith("<")
    && !value.startsWith("/")
    && !value.includes("\\")
    && value !== "."
    && value !== ".."
    && !value.startsWith("../")
    && !value.includes("/../");
}

function supportedSuccessfulChange(change: AgentPatchChange): boolean {
  return change.payloadRecovered
    && !change.payloadTruncated
    && safeNormalizedPath(change.path)
    && (change.movedFrom === undefined || safeNormalizedPath(change.movedFrom))
    && ((change.changeType === "update" && change.payloadKind === "unified-diff" && change.matchSide === "added")
      || (change.changeType === "add" && change.payloadKind === "content" && change.matchSide === "content")
      || (change.changeType === "delete" && change.payloadKind === "content" && change.matchSide === "deleted"));
}

function appendReason(
  reasons: CannotProveReason[],
  value: CannotProveReason,
): void {
  if (!reasons.includes(value)) reasons.push(value);
}

export function classifyStrongPossibility(
  request: StrongPossibilityRequest,
): CandidateStrongPossibility {
  if (request.repositoryMatch === "incompatible"
    && request.relevanceCoverage.status === "complete") {
    return { state: "excluded", reason: "repository-incompatible" };
  }

  const reasons: CannotProveReason[] = [];
  if (request.pathClassificationComplete === false) {
    appendReason(reasons, "path-classification-unknown");
  }
  if (request.relevanceCoverage.status !== "complete") {
    appendReason(reasons, "relevance-coverage-limited");
  }
  if (request.repositoryMatch === "unknown") {
    appendReason(reasons, "repository-identity-unknown");
  }
  if (request.repositoryMatch === "incompatible") {
    appendReason(reasons, "repository-identity-unknown");
  }

  const successfulResults = request.correlationEvidence.evidence.filter((evidence) =>
    evidence.kind === "patch-result" && evidence.reportedSuccess === true);
  for (const evidence of request.correlationEvidence.evidence) {
    if (evidence.kind !== "patch-result") continue;
    if (evidence.reportedSuccess === true
      && (evidence.resultRecorded !== true || evidence.patch === undefined)) {
      appendReason(reasons, "payload-or-hunk-inconclusive");
    }
  }

  const supportedChanges: AgentPatchChange[] = [];
  for (const evidence of successfulResults) {
    if (evidence.resultRecorded !== true || evidence.patch === undefined) continue;
    if (evidence.patch.changes.length === 0) {
      continue;
    }
    for (const change of evidence.patch.changes) {
      if (!supportedSuccessfulChange(change)) {
        appendReason(reasons, safeNormalizedPath(change.path)
          && (change.movedFrom === undefined || safeNormalizedPath(change.movedFrom))
          ? "payload-or-hunk-inconclusive"
          : "path-classification-unknown");
        continue;
      }
      supportedChanges.push(change);
    }
  }

  if (request.relevanceCoverage.status === "complete"
    && reasons.length === 0
    && successfulResults.length === 0) {
    return { state: "proven-not-strong", reason: "no-successful-supported-patch" };
  }

  if (request.relevanceCoverage.status === "complete"
    && reasons.length === 0
    && supportedChanges.length === successfulResults.reduce(
      (count, evidence) => count + (evidence.patch?.changes.length ?? 0),
      0,
    )) {
    const overlapsTarget = supportedChanges.some((change) =>
      request.targetAliases.has(change.path)
        || (change.movedFrom !== undefined && request.targetAliases.has(change.movedFrom)));
    if (!overlapsTarget) {
      return { state: "proven-not-strong", reason: "successful-supported-patch-paths-disjoint" };
    }
    appendReason(reasons, "potentially-relevant-supported-patch");
  }

  if (reasons.length === 0) {
    appendReason(reasons, "potentially-relevant-supported-patch");
  }
  return { state: "cannot-prove", reasons };
}

export interface CandidateBuildRequest {
  readonly session: AgentSessionSummary;
  readonly evidence?: AgentEvidenceBundle | null;
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly references: readonly ResolvedCommitReference[];
  readonly coverageLimitations?: readonly CorrelationLimitation[];
}

function hasSafeAnchor(references: readonly ResolvedCommitReference[]): boolean {
  return references.some((reference) =>
    reference.resolution === "target"
      && (reference.kind === "session-head" || reference.kind === "produced-commit"));
}

function appendLimitation(
  limitations: readonly CorrelationLimitation[],
  limitation: CorrelationLimitation,
): readonly CorrelationLimitation[] {
  if (limitations.some((value) => value.kind === limitation.kind)) {
    return limitations;
  }
  return [...limitations, limitation];
}

export function buildCandidateInput(
  request: CandidateBuildRequest,
): CorrelationCandidateInput {
  let coverageLimitations = [...(request.coverageLimitations ?? [])];
  const supportedSummary = request.session.sessionId !== null;
  const incompatible = request.repositoryMatch === "incompatible";
  const requiresAnchor = request.repositoryMatch === "unknown"
    || request.repositoryMatch === "historical-commit-anchored";
  const hasAnchor = hasSafeAnchor(request.references);

  if (!supportedSummary) {
    coverageLimitations = [...appendLimitation(coverageLimitations, {
      kind: "unsupported-summary",
      material: true,
    })];
  }
  if (requiresAnchor && !hasAnchor) {
    coverageLimitations = [...appendLimitation(coverageLimitations, {
      kind: "unresolved-repository-candidate",
      material: true,
    })];
  }

  return {
    session: request.session,
    evidence: request.evidence ?? null,
    repositoryMatch: request.repositoryMatch,
    eligible: supportedSummary && !incompatible && (!requiresAnchor || hasAnchor),
    references: request.references,
    coverageLimitations,
  };
}

export function buildCandidateInputs(
  requests: readonly CandidateBuildRequest[],
): readonly CorrelationCandidateInput[] {
  return requests.map(buildCandidateInput);
}

export const buildCandidates = buildCandidateInputs;
export const buildCandidate = buildCandidateInput;
