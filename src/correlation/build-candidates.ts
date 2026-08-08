import type {
  AgentEvidenceBundle,
  AgentSessionSummary,
} from "../agents/agent-history-source.js";
import type {
  CorrelationCandidateInput,
  CorrelationLimitation,
  CorrelationRepositoryMatch,
  ResolvedCommitReference,
} from "./model.js";

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
