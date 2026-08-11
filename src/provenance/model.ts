import type { CorrelationResult } from "../correlation/model.js";
import type { GitAncestryResult } from "../ancestry/model.js";

export type ClaimBasis = "fact" | "derived" | "inferred";

export type TargetFileState =
  | "clean"
  | "modified"
  | "untracked"
  | "deleted"
  | "unmerged";

export interface FileSnapshot {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly dev: number;
  readonly digest: string;
}

export interface CodeLocation {
  readonly input: string;
  readonly absolutePath: string;
  readonly repositoryPath: string;
  readonly requestedLine: number;
  readonly lineContent: string;
  /** Ephemeral content evidence for this invocation, never a durable identity. */
  readonly lineDigest: string;
  readonly fileSnapshot: FileSnapshot;
}

export interface ResolvedCodeLocation extends CodeLocation {
  readonly targetState: TargetFileState;
  readonly targetDirty: boolean;
}

export interface WorktreeInfo {
  readonly path: string;
  readonly headCommit: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export interface RepositoryContext {
  readonly worktreeRoot: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly objectFormat: string;
  readonly isShallow: boolean;
  readonly headCommit: string;
  readonly branch: string | null;
  readonly worktrees: readonly WorktreeInfo[];
}

export interface GitBlameAttribution {
  readonly basis: "fact";
  readonly objectId: string;
  readonly uncommitted: boolean;
  readonly originalLine: number;
  readonly finalLine: number;
  readonly authorName: string | null;
  readonly authorEmail: string | null;
  readonly authorTime: string | null;
  readonly authorTimezone: string | null;
  readonly committerName: string | null;
  readonly committerEmail: string | null;
  readonly committerTime: string | null;
  readonly committerTimezone: string | null;
  readonly filename: string;
  readonly previousCommit: string | null;
  readonly previousPath: string | null;
  readonly blobId: string | null;
  readonly lineContent: string;
}

export interface GitCommit {
  readonly basis: "fact";
  readonly id: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
}

export type ParentSelection =
  | {
      readonly basis: "derived";
      readonly kind: "root";
    }
  | {
      readonly basis: "derived";
      readonly kind: "commit";
      readonly commitId: string;
      readonly evidence: "blame-previous" | "sole-parent";
    }
  | {
      readonly basis: "derived";
      readonly kind: "ambiguous";
      readonly parentIds: readonly string[];
    }
  | {
      readonly basis: "derived";
      readonly kind: "unavailable";
      readonly reason: "shallow-history";
    };

export type GitPathChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "unknown";

export interface GitPathChange {
  readonly basis: "derived";
  readonly kind: GitPathChangeKind;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly similarity: number | null;
}

export type GitDiffLineKind = "added" | "deleted" | "context" | "metadata";

export interface GitDiffLine {
  readonly kind: GitDiffLineKind;
  readonly text: string;
}

export interface GitHunk {
  readonly basis: "derived";
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly targetLineKind: "added" | "context" | null;
  readonly lines: readonly GitDiffLine[];
  readonly raw: string;
  readonly truncated: boolean;
}

export interface GitProvenance {
  readonly state: "committed" | "uncommitted";
  readonly targetDirty: boolean;
  readonly targetState: TargetFileState;
  readonly blame: GitBlameAttribution | null;
  readonly commit: GitCommit | null;
  readonly parent: ParentSelection | null;
  readonly changedPaths: readonly GitPathChange[];
  readonly relevantHunks: readonly GitHunk[];
  readonly limitations: readonly string[];
}

export interface WhylineReport {
  readonly repository: RepositoryContext;
  readonly location: ResolvedCodeLocation;
  readonly provenance: GitProvenance;
  readonly ancestry?: GitAncestryResult;
  readonly correlation?: CorrelationResult;
}
