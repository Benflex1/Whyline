export type GitAncestryStatus =
  | "exact"
  | "transformed"
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

export interface PreservedAnchorProof {
  readonly basis: "derived";
  readonly childStartLine: number;
  readonly parentStartLine: number;
  readonly matchedLineCount: number;
  readonly distinctiveLineCount: number;
  readonly alphanumericCount: number;
  readonly comparison: "exact-lines";
}

export interface DeclarationHunkProof {
  readonly basis: "derived";
  readonly queriedChildLine: number;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly connection: "parent-overlap" | "insertion-within-parent";
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
      readonly status: "transformed";
      readonly relationship: "direct-parent-declaration";
      readonly textualCommitId: string;
      readonly parentCommitId: string;
      readonly childPath: string;
      readonly parentPath: string;
      readonly childDeclaration: import("../symbol/model.js").DeclarationDescriptor;
      readonly parentDeclaration: import("../symbol/model.js").DeclarationDescriptor;
      readonly parentSelectionEvidence: "blame-previous" | "sole-parent";
      readonly hunk: DeclarationHunkProof;
      readonly anchor: PreservedAnchorProof;
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "uncertain";
      readonly reason:
        | "insufficient-distinctive-context"
        | "candidate-not-exact"
        | "ambiguous-exact-source"
        | "insufficient-declaration-correspondence"
        | "ambiguous-declaration-correspondence";
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
        | "unsupported-object"
        | "work-bound";
      readonly candidate?: GitLineAncestor;
      readonly limitations: readonly string[];
    };
