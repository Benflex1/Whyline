import type { CorrelationLimitationKind } from "../correlation/model.js";

const FIXED_PREFIX = "whyline.correlation" as const;

const FIXED_METRIC_NAMES = [
  `${FIXED_PREFIX}.discovered_refs`,
  `${FIXED_PREFIX}.bytes_scanned`,
  `${FIXED_PREFIX}.summary_relevance.wall_ms`,
  `${FIXED_PREFIX}.summary_relevance.queue_ms_sum`,
  `${FIXED_PREFIX}.summary_relevance.queue_ms_max`,
  `${FIXED_PREFIX}.summary_relevance.work_ms_sum`,
  `${FIXED_PREFIX}.candidates.current_worktree`,
  `${FIXED_PREFIX}.candidates.linked_worktree`,
  `${FIXED_PREFIX}.candidates.same_common_directory`,
  `${FIXED_PREFIX}.candidates.historical_commit_anchored`,
  `${FIXED_PREFIX}.candidates.unknown`,
  `${FIXED_PREFIX}.candidates.incompatible`,
  `${FIXED_PREFIX}.candidates.unsupported_summary`,
  `${FIXED_PREFIX}.proven_not_strong`,
  `${FIXED_PREFIX}.potentially_strong`,
  `${FIXED_PREFIX}.git_classification.calls`,
  `${FIXED_PREFIX}.git_classification.wall_ms`,
  `${FIXED_PREFIX}.git_classification.queue_ms_sum`,
  `${FIXED_PREFIX}.git_classification.queue_ms_max`,
  `${FIXED_PREFIX}.git_classification.process_ms_sum`,
  `${FIXED_PREFIX}.full_evidence.candidates`,
  `${FIXED_PREFIX}.full_evidence.bytes_read`,
  `${FIXED_PREFIX}.full_evidence.read_ms_sum`,
  `${FIXED_PREFIX}.full_evidence.wall_ms`,
  `${FIXED_PREFIX}.full_evidence.queue_ms_sum`,
  `${FIXED_PREFIX}.full_evidence.queue_ms_max`,
  `${FIXED_PREFIX}.full_evidence.work_ms_sum`,
  `${FIXED_PREFIX}.total_ms`,
  ...([
    "empty-readable-store",
    "discovery-unavailable",
    "discovery-limited",
    "unsupported-summary",
    "unresolved-repository-candidate",
    "candidate-cap",
    "summary-coverage",
    "partial-transcript",
    "corrupt-transcript",
    "changed-during-read",
    "truncated-git-hunk",
    "truncated-patch-payload",
    "material-compaction",
    "material-rollback-or-abort",
  ] satisfies readonly CorrelationLimitationKind[]).map((kind) =>
    `${FIXED_PREFIX}.material_coverage.${kind}`),
] as const;

export type CorrelationMetricName = (typeof FIXED_METRIC_NAMES)[number];
export type CorrelationTelemetrySnapshot = Readonly<Record<CorrelationMetricName, number>>;

function zeroMetrics(): Record<CorrelationMetricName, number> {
  return Object.fromEntries(FIXED_METRIC_NAMES.map((name) => [name, 0])) as Record<CorrelationMetricName, number>;
}

export class CorrelationTelemetry {
  private readonly values = zeroMetrics();

  public set(name: CorrelationMetricName, value: number): void {
    if (!Object.hasOwn(this.values, name)) {
      throw new Error("unknown correlation telemetry metric");
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("correlation telemetry values must be finite non-negative numbers");
    }
    this.values[name] = value;
  }

  public add(name: CorrelationMetricName, value: number): void {
    this.set(name, (this.values[name] ?? 0) + value);
  }

  public snapshot(): CorrelationTelemetrySnapshot {
    return { ...this.values };
  }
}

export { FIXED_METRIC_NAMES };
