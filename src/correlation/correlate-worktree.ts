import type {
  CorrelationCandidate,
  CorrelationCandidateInput,
  CorrelationCoverage,
  CorrelationLimitation,
  CorrelationResult,
  WorktreeCorrelationTarget,
} from "./model.js";
import { scoreWorktreeCandidate } from "./score-worktree-candidate.js";

function compareCandidates(left: CorrelationCandidate, right: CorrelationCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  return (left.session.sessionId ?? "").localeCompare(right.session.sessionId ?? "");
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

function withLimitations(
  coverage: CorrelationCoverage,
  limitations: readonly CorrelationLimitation[],
): CorrelationCoverage {
  const merged = new Map<CorrelationLimitation["kind"], CorrelationLimitation>();
  for (const value of [...coverage.limitations, ...limitations]) {
    const previous = merged.get(value.kind);
    merged.set(value.kind, previous === undefined ? value : mergeLimitations(previous, value));
  }
  const values = [...merged.values()];
  return {
    ...coverage,
    status: coverage.status === "unavailable"
      ? "unavailable"
      : values.some((value) => value.material) ? "limited" : coverage.status,
    limitations: values,
  };
}

export function correlateWorktree(
  target: WorktreeCorrelationTarget,
  inputs: readonly CorrelationCandidateInput[],
  coverage: CorrelationCoverage,
): CorrelationResult {
  const inputLimitations = inputs.flatMap((input) => input.coverageLimitations);
  const initialCoverage = withLimitations(coverage, inputLimitations);
  if (initialCoverage.status === "unavailable") {
    return { status: "unavailable", alternatives: [], coverage: initialCoverage };
  }

  const scored = inputs
    .filter((input) => input.eligible && input.repositoryMatch !== "incompatible")
    .map((input) => ({ input, candidate: scoreWorktreeCandidate(target, input) }))
    .sort((left, right) => compareCandidates(left.candidate, right.candidate));
  const candidateLimitations = scored.flatMap((value) => value.candidate.coverageLimitations
    .filter((limitation) => limitation.material
      && !value.input.coverageLimitations.some((existing) => existing.kind === limitation.kind)));
  const effectiveCoverage = withLimitations(initialCoverage, candidateLimitations);
  const candidates = scored.map((value) => value.candidate);
  const visible = candidates.filter((candidate) => candidate.band !== "weak");
  const strong = candidates.filter((candidate) => candidate.band === "strong");
  if (strong.length >= 2) return { status: "ambiguous", alternatives: visible, coverage: effectiveCoverage };

  const selected = strong[0];
  const sufficient = effectiveCoverage.status === "complete"
    && effectiveCoverage.omittedPotentiallyStrongRefs === 0
    && effectiveCoverage.fullyProjectedRefs >= effectiveCoverage.potentiallyStrongRefs
    && !effectiveCoverage.limitations.some((value) => value.material)
    && candidates.every((candidate) => !candidate.coverageLimitations.some((value) => value.material));
  if (selected !== undefined && sufficient) {
    return {
      status: "matched",
      selected,
      alternatives: visible.filter((candidate) => candidate !== selected),
      coverage: effectiveCoverage,
    };
  }
  return { status: "none", alternatives: visible, coverage: effectiveCoverage };
}
