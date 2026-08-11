export type GitAncestryStatus =
  | "exact"
  | "uncertain"
  | "none"
  | "unavailable";

export type ExactTransitionKind =
  | "same-file-move"
  | "cross-file-move-or-copy"
  | "renamed-path"
  | "unclassified-exact";

export interface ExactBlockProof {
  readonly basis: "derived";
  readonly currentStartLine: number;
  readonly ancestorStartLine: number;
  readonly matchedLineCount: number;
  readonly distinctiveLineCount: number;
  readonly alphanumericCount: number;
  readonly comparison: "exact-lines";
}

export interface ExactBlockInput {
  readonly currentLines: readonly string[];
  readonly currentLine: number;
  readonly ancestorLines: readonly string[];
  readonly ancestorLine: number;
  readonly currentComplete: boolean;
  readonly ancestorComplete: boolean;
}

export interface GitLineAncestor {
  readonly commitId: string;
  readonly path: string;
  readonly line: number;
}

export type GitAncestryResult =
  | {
      readonly status: "exact";
      readonly relationship: "exact-ancestor";
      readonly transition: ExactTransitionKind;
      readonly ancestor: GitLineAncestor;
      readonly ancestorSubject: string;
      readonly proof: ExactBlockProof;
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "uncertain";
      readonly reason:
        | "insufficient-distinctive-context"
        | "candidate-not-exact"
        | "ambiguous-exact-source";
      readonly candidate?: GitLineAncestor;
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "none";
      readonly reason:
        | "no-earlier-move-copy-attribution"
        | "root-history-boundary";
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "ambiguous-parent"
        | "missing-history"
        | "unsupported-object";
      readonly candidate?: GitLineAncestor;
      readonly limitations: readonly string[];
    };
