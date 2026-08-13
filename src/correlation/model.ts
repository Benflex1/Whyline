import type {
  AgentCommitReferenceKind,
  AgentEvidenceBundle,
  AgentPatchChange,
  AgentSessionSummary,
} from "../agents/agent-history-source.js";
import type { RangeLineSpan } from "../provenance/range-model.js";
import type { FileSnapshot } from "../provenance/model.js";

export type CorrelationSignalKind =
  | "session-head-target-reference"
  | "produced-target-commit-reference"
  | "historical-commit-reference"
  | "structured-patch-overlap"
  | "exact-current-worktree"
  | "linked-worktree-common-directory"
  | "structured-patch-target-path"
  | "changed-path-overlap"
  | "structured-patch-attempt-target-path"
  | "temporal-proximity"
  | "structured-content-divergence";

export type CorrelationRepositoryMatch =
  | "current-worktree"
  | "linked-worktree"
  | "same-common-directory"
  | "historical-commit-anchored"
  | "unknown"
  | "incompatible";

export interface CorrelationHunk {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly targetLineKind: "added" | "context" | null;
  readonly addedLineFingerprints: readonly string[];
  readonly deletedLineFingerprints: readonly string[];
  readonly distinctiveAddedLineFingerprints: readonly string[];
  readonly distinctiveDeletedLineFingerprints: readonly string[];
  readonly truncated: boolean;
}

export interface CorrelationRepositoryIdentity {
  readonly worktreeRoot: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly objectFormat: string;
  readonly worktrees: readonly {
    readonly path: string;
    readonly commonGitDir: string;
  }[];
}

export interface CommitCorrelationTarget {
  readonly kind: "commit";
  readonly repository: CorrelationRepositoryIdentity;
  readonly targetPath: string;
  readonly blamedPath: string | null;
  readonly commit: {
    readonly id: string;
    readonly authoredAt: string;
    readonly committedAt: string;
  };
  readonly selectedParentId: string | null;
  readonly changedPaths: readonly {
    readonly oldPath: string | null;
    readonly newPath: string | null;
  }[];
  readonly relevantHunks: readonly CorrelationHunk[];
}

/** Compatibility alias for the pre-union committed correlation target. */
export type CorrelationTarget = CommitCorrelationTarget;

export interface WorktreeCorrelationHunk extends CorrelationHunk {
  readonly basis: "derived";
  readonly operation: "update" | "add";
  readonly queriedSpans: readonly RangeLineSpan[];
  readonly currentLineFingerprints: readonly string[];
  readonly currentDistinctiveLineFingerprints: readonly string[];
  readonly currentLineAlphanumericCounts: readonly number[];
  readonly complete: true;
}

export interface WorktreeTargetSnapshot {
  readonly baseCommitId: string;
  readonly repositoryPath: string;
  readonly changeKind: WorktreeCorrelationTarget["changeKind"];
  readonly fileSnapshot: FileSnapshot;
  readonly evidenceDigest: string;
}

export interface WorktreeCorrelationTarget {
  readonly kind: "worktree";
  readonly basis: "derived";
  readonly repository: CorrelationRepositoryIdentity;
  readonly baseCommitId: string;
  readonly targetPath: string;
  readonly changeKind: "modified" | "added";
  readonly staging: "staged" | "unstaged" | "partially-staged" | "untracked" | "unknown";
  readonly queriedSpans: readonly RangeLineSpan[];
  readonly relevantHunks: readonly [WorktreeCorrelationHunk];
  readonly targetSnapshot: WorktreeTargetSnapshot;
}

export type ProvenanceCorrelationTarget = CommitCorrelationTarget | WorktreeCorrelationTarget;

export type WorktreeTargetConstruction =
  | {
      readonly status: "ready";
      readonly queriedSpans: readonly RangeLineSpan[];
      readonly target: WorktreeCorrelationTarget;
    }
  | {
      readonly status: "insufficient";
      readonly queriedSpans: readonly RangeLineSpan[];
      readonly reason: "query-not-current-side-change" | "insufficient-distinctive-material";
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "unavailable";
      readonly queriedSpans: readonly RangeLineSpan[];
      readonly reason: "unmerged" | "unsupported-change-shape" | "missing-head-object" | "incomplete-diff";
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "work-bound";
      readonly queriedSpans: readonly RangeLineSpan[];
      readonly reason: "file-too-large" | "hunk-too-large" | "group-limit";
      readonly limitations: readonly string[];
    };

export interface CorrelationSignal {
  readonly kind: CorrelationSignalKind;
  readonly weight: number;
  readonly basis: "fact" | "derived" | "inferred";
  readonly evidenceIds: readonly string[];
}

export type CorrelationLimitationKind =
  | "empty-readable-store"
  | "discovery-unavailable"
  | "discovery-limited"
  | "unsupported-summary"
  | "unresolved-repository-candidate"
  | "candidate-cap"
  | "summary-coverage"
  | "partial-transcript"
  | "corrupt-transcript"
  | "changed-during-read"
  | "truncated-git-hunk"
  | "truncated-patch-payload"
  | "material-compaction"
  | "material-rollback-or-abort";

export interface CorrelationLimitation {
  readonly kind: CorrelationLimitationKind;
  readonly material: boolean;
  readonly count?: number;
}

export interface CorrelationCoverage {
  readonly status: "complete" | "limited" | "unavailable";
  readonly discoveredRefs: number;
  readonly usableSummaryRefs: number;
  readonly incompatibleRefs: number;
  readonly provenNotStrongRefs: number;
  readonly potentiallyStrongRefs: number;
  readonly fullyProjectedRefs: number;
  readonly omittedPotentiallyStrongRefs: number;
  readonly limitations: readonly CorrelationLimitation[];
}

export type ProvenNotStrongReason =
  | "no-successful-supported-patch"
  | "successful-supported-patch-paths-disjoint";

export type CannotProveReason =
  | "potentially-relevant-supported-patch"
  | "repository-identity-unknown"
  | "path-classification-unknown"
  | "relevance-coverage-limited"
  | "payload-or-hunk-inconclusive";

export type CandidateStrongPossibility =
  | {
    readonly state: "excluded";
    readonly reason: "repository-incompatible";
  }
  | {
    readonly state: "proven-not-strong";
    readonly reason: ProvenNotStrongReason;
  }
  | {
    readonly state: "cannot-prove";
    readonly reasons: readonly CannotProveReason[];
  };

export interface ResolvedCommitReference {
  readonly kind: AgentCommitReferenceKind;
  readonly reference: string;
  readonly resolution: "target" | "other" | "ambiguous" | "unresolved";
}

export interface CorrelationCandidateInput {
  readonly session: AgentSessionSummary;
  readonly evidence: AgentEvidenceBundle | null;
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly eligible: boolean;
  readonly references: readonly ResolvedCommitReference[];
  readonly coverageLimitations: readonly CorrelationLimitation[];
}

export interface CorrelationCandidate {
  readonly session: AgentSessionSummary;
  readonly eligible: boolean;
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly score: number;
  readonly signals: readonly CorrelationSignal[];
  readonly contradictions: readonly CorrelationSignal[];
  readonly band: "strong" | "plausible" | "weak";
  readonly coverage: "complete" | "limited";
  readonly coverageLimitations: readonly CorrelationLimitation[];
}

export interface CorrelationResult {
  readonly status: "matched" | "ambiguous" | "none" | "unavailable";
  readonly selected?: CorrelationCandidate;
  readonly alternatives: readonly CorrelationCandidate[];
  readonly coverage: CorrelationCoverage;
}

export type { AgentPatchChange };
