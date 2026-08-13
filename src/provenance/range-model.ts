import type {
  DeclarationHunkProof,
  ExactBlockProof,
  ExactTransitionKind,
  GitLineAncestor,
  PreservedAnchorProof,
} from "../ancestry/model.js";
import type { DeclarationDescriptor } from "../symbol/model.js";
import type { CorrelationResult } from "../correlation/model.js";
import type {
  GitBlameAttribution,
  GitCommit,
  GitHunk,
  GitPathChange,
  ParentSelection,
  RepositoryContext,
  ResolvedRangeCodeLocation,
} from "./model.js";
import { parentSelectionKey } from "./parent-key.js";

export interface RangeLineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

export interface RangeLineAttribution {
  readonly queryLine: number;
  readonly blame: GitBlameAttribution;
}

export interface RangeLineInspection {
  readonly commit: GitCommit | null;
  readonly parent: ParentSelection | null;
  readonly changedPaths: readonly GitPathChange[];
  readonly relevantHunks: readonly GitHunk[];
  readonly limitations: readonly string[];
}

export interface RangeTextualGroup {
  readonly id: string;
  readonly spans: readonly RangeLineSpan[];
  readonly lines: readonly RangeLineAttribution[];
  readonly state: "committed" | "uncommitted";
  readonly commit: GitCommit | null;
  readonly parent: ParentSelection | null;
  readonly blamedPath: string | null;
  readonly changedPaths: readonly GitPathChange[];
  readonly relevantHunks: readonly GitHunk[];
  readonly limitations: readonly string[];
}

export type RangeAncestrySegmentStatus =
  | "exact"
  | "transformed"
  | "uncertain"
  | "none"
  | "unavailable"
  | "not-run"
  | "work-bound";

export interface RangeAncestrySegment {
  readonly span: RangeLineSpan;
  readonly status: RangeAncestrySegmentStatus;
  readonly candidate?: GitLineAncestor;
  readonly ancestor?: GitLineAncestor;
  readonly ancestorSubject?: string;
  readonly transition?: ExactTransitionKind;
  readonly proof?: ExactBlockProof;
  readonly transformed?: {
    readonly textualCommitId: string;
    readonly parentCommitId: string;
    readonly childPath: string;
    readonly parentPath: string;
    readonly childDeclaration: DeclarationDescriptor;
    readonly parentDeclaration: DeclarationDescriptor;
    readonly parentSelectionEvidence: "blame-previous" | "sole-parent";
    readonly hunk: DeclarationHunkProof;
    readonly anchor: PreservedAnchorProof;
  };
  readonly limitations: readonly string[];
}

export interface RangeAncestryCoverage {
  readonly segments: readonly RangeAncestrySegment[];
  readonly limitations: readonly string[];
}

export type RangeCorrelationStatus =
  | "matched"
  | "ambiguous"
  | "none"
  | "unavailable"
  | "insufficient"
  | "not-run"
  | "work-bound";

export interface RangeCorrelationGroup {
  readonly groupId: string;
  readonly analysisGroupId: string;
  readonly textualGroupId: string;
  readonly targetKind: "commit" | "worktree";
  readonly spans: readonly RangeLineSpan[];
  readonly status: RangeCorrelationStatus;
  readonly result?: CorrelationResult;
  readonly limitations: readonly string[];
}

export interface RangeAnalysisCoverage {
  readonly committedGroups: number;
  readonly deepAnalyzedGroups: number;
  readonly workBoundGroups: number;
  readonly uncommittedGroups: number;
}

export interface WhylineRangeReport {
  readonly repository: RepositoryContext;
  readonly location: ResolvedRangeCodeLocation;
  readonly lineAttributions: readonly RangeLineAttribution[];
  readonly textualGroups: readonly RangeTextualGroup[];
  readonly ancestry: ReadonlyMap<string, RangeAncestryCoverage>;
  readonly correlations: readonly RangeCorrelationGroup[];
  readonly coverage: RangeAnalysisCoverage;
}

function groupKey(
  fact: RangeLineAttribution,
  inspection: RangeLineInspection,
): string {
  const state = fact.blame.uncommitted ? "uncommitted" : "committed";
  const commit = inspection.commit?.id ?? fact.blame.objectId;
  return [
    state,
    commit,
    fact.blame.filename,
    parentSelectionKey(inspection.parent),
  ].join("\u0000");
}

function spansFor(lines: readonly RangeLineAttribution[]): readonly RangeLineSpan[] {
  const sorted = [...lines].sort((left, right) => left.queryLine - right.queryLine);
  const spans: RangeLineSpan[] = [];
  for (const line of sorted) {
    const previous = spans[spans.length - 1];
    if (previous !== undefined && previous.endLine + 1 === line.queryLine) {
      spans[spans.length - 1] = { startLine: previous.startLine, endLine: line.queryLine };
    } else {
      spans.push({ startLine: line.queryLine, endLine: line.queryLine });
    }
  }
  return spans;
}

export function groupTextualAttributions(
  facts: readonly RangeLineAttribution[],
  inspections: ReadonlyMap<number, RangeLineInspection>,
): readonly RangeTextualGroup[] {
  interface MutableGroup {
    readonly key: string;
    readonly lines: RangeLineAttribution[];
    readonly inspection: RangeLineInspection;
  }

  const groups = new Map<string, MutableGroup>();
  for (const fact of facts) {
    const inspection = inspections.get(fact.queryLine);
    if (inspection === undefined) {
      throw new Error("range line inspection is missing");
    }
    const key = groupKey(fact, inspection);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, lines: [fact], inspection });
    } else {
      existing.lines.push(fact);
    }
  }

  return [...groups.values()]
    .sort((left, right) => {
      const leftLine = left.lines[0]?.queryLine ?? Number.MAX_SAFE_INTEGER;
      const rightLine = right.lines[0]?.queryLine ?? Number.MAX_SAFE_INTEGER;
      return leftLine - rightLine;
    })
    .map((group, index): RangeTextualGroup => ({
      id: "textual-" + (index + 1),
      spans: spansFor(group.lines),
      lines: [...group.lines].sort((left, right) => left.queryLine - right.queryLine),
      state: group.lines[0]?.blame.uncommitted === true ? "uncommitted" : "committed",
      commit: group.inspection.commit,
      parent: group.inspection.parent,
      blamedPath: group.lines[0]?.blame.filename ?? null,
      changedPaths: group.inspection.changedPaths,
      relevantHunks: group.inspection.relevantHunks,
      limitations: [...new Set(group.inspection.limitations)],
    }));
}
