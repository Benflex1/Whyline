import type {
  CorrelationCandidate,
  CorrelationCandidateInput,
  CorrelationCoverage,
  CorrelationLimitation,
  CorrelationResult,
  CorrelationTarget,
} from "./model.js";
import { scoreCandidate } from "./score-candidate.js";

function compareCandidates(left: CorrelationCandidate, right: CorrelationCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  const leftId = left.session.sessionId ?? "";
  const rightId = right.session.sessionId ?? "";
  if (leftId !== rightId) return leftId.localeCompare(rightId);
  return left.session.ref.sourcePath.localeCompare(right.session.ref.sourcePath);
}

function visibleCandidates(candidates: readonly CorrelationCandidate[]): readonly CorrelationCandidate[] {
  return candidates.filter((candidate) => candidate.band !== "weak");
}

function mergeLimitations(
  left: CorrelationLimitation,
  right: CorrelationLimitation,
): CorrelationLimitation {
  const count = (left.count ?? 0) + (right.count ?? 0);
  return count === 0
    ? { kind: left.kind, material: left.material || right.material }
    : { kind: left.kind, material: left.material || right.material, count };
}

function coverageWithCandidateLimitations(
  coverage: CorrelationCoverage,
  inputs: readonly CorrelationCandidateInput[],
): CorrelationCoverage {
  const limitations = new Map<CorrelationLimitation["kind"], CorrelationLimitation>();
  const add = (limitation: CorrelationLimitation): void => {
    const existing = limitations.get(limitation.kind);
    limitations.set(
      limitation.kind,
      existing === undefined ? limitation : mergeLimitations(existing, limitation),
    );
  };

  for (const limitation of coverage.limitations) add(limitation);
  for (const input of inputs) {
    for (const limitation of input.coverageLimitations) add(limitation);
  }
  return { ...coverage, limitations: [...limitations.values()] };
}

function sufficientCoverage(
  target: CorrelationTarget,
  candidates: readonly CorrelationCandidate[],
  coverage: CorrelationCoverage,
): boolean {
  if (coverage.status !== "complete") return false;
  if (coverage.omittedEligibleRefs > 0) return false;
  if (coverage.fullyExtractedRefs < coverage.summaryEligibleRefs) return false;
  if (coverage.limitations.some((limitation) => limitation.material)) return false;
  if (target.relevantHunks.some((hunk) => hunk.truncated)) return false;
  return candidates.every((candidate) =>
    !candidate.coverageLimitations.some((limitation) => limitation.material));
}

export function correlate(
  target: CorrelationTarget,
  inputs: readonly CorrelationCandidateInput[],
  coverage: CorrelationCoverage,
): CorrelationResult {
  const effectiveCoverage = coverageWithCandidateLimitations(coverage, inputs);
  if (effectiveCoverage.status === "unavailable") {
    return {
      status: "unavailable",
      alternatives: [],
      coverage: effectiveCoverage,
    };
  }

  const candidates = inputs
    .filter((input) => input.eligible && input.repositoryMatch !== "incompatible")
    .map((input) => scoreCandidate(target, input))
    .sort(compareCandidates);
  const strong = candidates.filter((candidate) => candidate.band === "strong");
  const alternatives = visibleCandidates(candidates);

  if (strong.length >= 2) {
    return { status: "ambiguous", alternatives, coverage: effectiveCoverage };
  }

  const onlyStrong = strong[0];
  if (onlyStrong !== undefined && sufficientCoverage(target, candidates, effectiveCoverage)) {
    return {
      status: "matched",
      selected: onlyStrong,
      alternatives: alternatives.filter((candidate) => candidate !== onlyStrong),
      coverage: effectiveCoverage,
    };
  }

  return {
    status: "none",
    alternatives,
    coverage: effectiveCoverage,
  };
}
