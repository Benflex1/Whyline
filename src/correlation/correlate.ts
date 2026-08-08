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
  return 0;
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

function coverageWithLimitations(
  coverage: CorrelationCoverage,
  limitationsToMerge: readonly CorrelationLimitation[],
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
  for (const limitation of limitationsToMerge) add(limitation);
  const mergedLimitations = [...limitations.values()];
  const status = coverage.status === "unavailable"
    ? "unavailable"
    : mergedLimitations.some((limitation) => limitation.material)
      ? "limited"
      : coverage.status;
  return { ...coverage, status, limitations: mergedLimitations };
}

function coverageWithInputLimitations(
  coverage: CorrelationCoverage,
  inputs: readonly CorrelationCandidateInput[],
): CorrelationCoverage {
  const limitations: CorrelationLimitation[] = [];
  for (const input of inputs) limitations.push(...input.coverageLimitations);
  return coverageWithLimitations(coverage, limitations);
}

interface ScoredCandidate {
  readonly input: CorrelationCandidateInput;
  readonly candidate: CorrelationCandidate;
}

function coverageWithCandidateLimitations(
  coverage: CorrelationCoverage,
  scoredCandidates: readonly ScoredCandidate[],
): CorrelationCoverage {
  const limitations: CorrelationLimitation[] = [];
  for (const scored of scoredCandidates) {
    for (const limitation of scored.candidate.coverageLimitations) {
      if (!limitation.material
        || scored.input.coverageLimitations.some((value) => value.kind === limitation.kind)) {
        continue;
      }
      limitations.push(limitation);
    }
  }
  return coverageWithLimitations(coverage, limitations);
}

function coverageWithTargetLimitations(
  coverage: CorrelationCoverage,
  target: CorrelationTarget,
): CorrelationCoverage {
  const limitations: CorrelationLimitation[] = target.relevantHunks.some((hunk) => hunk.truncated)
    ? [{ kind: "truncated-git-hunk", material: true }]
    : [];
  return coverageWithLimitations(coverage, limitations);
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
  const inputCoverage = coverageWithInputLimitations(coverage, inputs);
  const targetCoverage = coverageWithTargetLimitations(inputCoverage, target);
  if (targetCoverage.status === "unavailable") {
    return {
      status: "unavailable",
      alternatives: [],
      coverage: targetCoverage,
    };
  }

  const scoredCandidates = inputs
    .filter((input) => input.eligible && input.repositoryMatch !== "incompatible")
    .map((input): ScoredCandidate => ({
      input,
      candidate: scoreCandidate(target, input),
    }))
    .sort((left, right) => compareCandidates(left.candidate, right.candidate));
  const effectiveCoverage = coverageWithCandidateLimitations(targetCoverage, scoredCandidates);
  const candidates = scoredCandidates.map((scored) => scored.candidate);
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
