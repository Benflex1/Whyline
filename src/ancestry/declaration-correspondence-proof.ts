import { isDistinctiveLine } from "../agents/codex/safe.js";
import type {
  DeclarationDescriptor,
  DeclarationFact,
} from "../symbol/model.js";
import type { GitHunk } from "../provenance/model.js";
import type {
  DeclarationHunkProof,
  PreservedAnchorProof,
} from "./model.js";

const MAX_DECLARATION_LINES = 200;
const MAX_ANCHOR_LINES = 32;
const MAX_LINE_PAIR_COMPARISONS = 40_000;

export interface DeclarationCorrespondenceProofInput {
  readonly childText: string;
  readonly parentText: string;
  readonly childLines: readonly string[];
  readonly parentLines: readonly string[];
  readonly childComplete: boolean;
  readonly parentComplete: boolean;
  readonly childDeclarations: readonly DeclarationFact[];
  readonly parentDeclarations: readonly DeclarationFact[];
  readonly queriedChildLine: number;
  readonly hunks: readonly GitHunk[];
  readonly exactEstablished: boolean;
}

export type DeclarationCorrespondenceUncertainReason =
  | "exact-already-established"
  | "ambiguous-child-declaration"
  | "no-child-declaration"
  | "no-parent-declaration"
  | "ambiguous-parent-declaration"
  | "disconnected-hunk"
  | "ambiguous-hunk"
  | "identical-declaration"
  | "insufficient-anchor"
  | "ambiguous-anchor";

export type DeclarationCorrespondenceUnavailableReason =
  | "incomplete-material"
  | "declaration-too-large"
  | "comparison-work-bound";

export type DeclarationCorrespondenceProofResult =
  | {
      readonly status: "transformed";
      readonly relationship: "direct-parent-declaration";
      readonly childDeclaration: DeclarationDescriptor;
      readonly parentDeclaration: DeclarationDescriptor;
      readonly hunk: DeclarationHunkProof;
      readonly anchor: PreservedAnchorProof;
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "uncertain";
      readonly reason: DeclarationCorrespondenceUncertainReason;
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "unavailable";
      readonly reason: DeclarationCorrespondenceUnavailableReason;
      readonly limitations: readonly string[];
    };

function uncertain(
  reason: DeclarationCorrespondenceUncertainReason,
  message: string,
): DeclarationCorrespondenceProofResult {
  return { status: "uncertain", reason, limitations: [message] };
}

function unavailable(
  reason: DeclarationCorrespondenceUnavailableReason,
  message: string,
): DeclarationCorrespondenceProofResult {
  return { status: "unavailable", reason, limitations: [message] };
}

function spanLength(value: DeclarationFact): number {
  return value.span.endLine - value.span.startLine + 1;
}

function containsLine(value: DeclarationFact, line: number): boolean {
  return value.span.startLine <= line && line <= value.span.endLine;
}

export function declarationAttemptIdentity(
  declarations: readonly DeclarationFact[],
  queriedChildLine: number,
): string {
  const covering = declarations.filter((value) => containsLine(value, queriedChildLine));
  if (covering.length === 0) return "none:" + queriedChildLine;
  const smallest = Math.min(...covering.map(spanLength));
  const innermost = covering.filter((value) => spanLength(value) === smallest);
  if (innermost.length !== 1) return "ambiguous:" + queriedChildLine;
  const value = innermost[0] as DeclarationFact;
  return [
    value.span.startLine,
    value.span.endLine,
    value.kind,
    value.qualifiedName,
    value.declarationForm,
    String(value.staticStatus),
  ].join(":");
}

function descriptor(value: DeclarationFact): DeclarationDescriptor {
  return {
    kind: value.kind,
    qualifiedName: value.qualifiedName,
    declarationForm: value.declarationForm,
    staticStatus: value.staticStatus,
    span: value.span,
  };
}

function sameKey(left: DeclarationFact, right: DeclarationFact): boolean {
  return left.kind === right.kind
    && left.qualifiedName === right.qualifiedName
    && left.declarationForm === right.declarationForm
    && left.staticStatus === right.staticStatus;
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function newLineKind(hunk: GitHunk, targetLine: number): "added" | "context" | "absent" {
  let nextNewLine = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.kind === "deleted" || line.kind === "metadata") continue;
    if (nextNewLine === targetLine) {
      return line.kind === "added" ? "added" : "context";
    }
    nextNewLine += 1;
  }
  return "absent";
}

type HunkProofResult = DeclarationHunkProof | null | "ambiguous" | "incomplete";

function hunkProof(
  input: DeclarationCorrespondenceProofInput,
  child: DeclarationFact,
  parent: DeclarationFact,
): HunkProofResult {
  const matches: DeclarationHunkProof[] = [];
  let incomplete = false;
  for (const hunk of input.hunks) {
    if (newLineKind(hunk, input.queriedChildLine) !== "added") continue;
    const newEnd = hunk.newStart + Math.max(0, hunk.newLines - 1);
    if (!rangesOverlap(hunk.newStart, newEnd, child.span.startLine, child.span.endLine)) continue;

    let connection: DeclarationHunkProof["connection"] | null = null;
    if (hunk.oldLines > 0) {
      const oldEnd = hunk.oldStart + hunk.oldLines - 1;
      if (rangesOverlap(hunk.oldStart, oldEnd, parent.span.startLine, parent.span.endLine)) {
        connection = "parent-overlap";
      }
    } else {
      const insertionPoint = hunk.oldStart === 0 ? 1 : hunk.oldStart;
      if (parent.span.startLine <= insertionPoint && insertionPoint <= parent.span.endLine) {
        connection = "insertion-within-parent";
      }
    }
    if (connection !== null) {
      if (hunk.truncated) {
        incomplete = true;
        continue;
      }
      matches.push({
        basis: "derived",
        queriedChildLine: input.queriedChildLine,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        connection,
      });
    }
  }
  if (incomplete) return "incomplete";
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0] as DeclarationHunkProof;
}

function declarationLines(
  lines: readonly string[],
  value: DeclarationFact,
): readonly string[] {
  return lines.slice(value.span.startLine - 1, value.span.endLine);
}

interface AnchorCandidate {
  readonly childStartLine: number;
  readonly parentStartLine: number;
  readonly matchedLineCount: number;
  readonly distinctiveLineCount: number;
  readonly alphanumericCount: number;
}

function alphanumericCount(lines: readonly string[]): number {
  return lines.reduce(
    (total, line) => total + (line.match(/[\p{L}\p{N}]/gu)?.length ?? 0),
    0,
  );
}

function anchorCandidate(
  childLines: readonly string[],
  childStartLine: number,
  parentStartLine: number,
  runLength: number,
): AnchorCandidate | null {
  const matchedLineCount = Math.min(runLength, MAX_ANCHOR_LINES);
  const matched = childLines.slice(0, matchedLineCount);
  const distinctiveLineCount = new Set(matched.filter(isDistinctiveLine)).size;
  const alphanumeric = alphanumericCount(matched);
  if (distinctiveLineCount < 2 || alphanumeric < 40) return null;
  return {
    childStartLine,
    parentStartLine,
    matchedLineCount,
    distinctiveLineCount,
    alphanumericCount: alphanumeric,
  };
}

function findAnchor(
  input: DeclarationCorrespondenceProofInput,
  child: DeclarationFact,
  parent: DeclarationFact,
): PreservedAnchorProof | "ambiguous" | "insufficient" | "work-bound" {
  const childLines = declarationLines(input.childLines, child);
  const parentLines = declarationLines(input.parentLines, parent);
  if (childLines.length * parentLines.length > MAX_LINE_PAIR_COMPARISONS) return "work-bound";

  const equal = childLines.map((childLine) =>
    parentLines.map((parentLine) => childLine === parentLine));
  const candidates: AnchorCandidate[] = [];
  for (let childIndex = 0; childIndex < childLines.length; childIndex += 1) {
    for (let parentIndex = 0; parentIndex < parentLines.length; parentIndex += 1) {
      if (equal[childIndex]?.[parentIndex] !== true) continue;
      if (childIndex > 0 && parentIndex > 0 && equal[childIndex - 1]?.[parentIndex - 1] === true) continue;
      let runLength = 0;
      while (
        childIndex + runLength < childLines.length
        && parentIndex + runLength < parentLines.length
        && equal[childIndex + runLength]?.[parentIndex + runLength] === true
      ) {
        runLength += 1;
      }
      const candidate = anchorCandidate(
        childLines.slice(childIndex),
        child.span.startLine + childIndex,
        parent.span.startLine + parentIndex,
        runLength,
      );
      if (candidate !== null) candidates.push(candidate);
    }
  }

  if (candidates.length === 0) return "insufficient";

  const unique = new Map(
    candidates.map((candidate) => [
      candidate.childStartLine + ":" + candidate.parentStartLine,
      candidate,
    ]),
  );
  if (unique.size !== 1) return "ambiguous";
  const candidate = [...unique.values()][0];
  if (candidate === undefined) return "insufficient";
  return {
    basis: "derived",
    childStartLine: candidate.childStartLine,
    parentStartLine: candidate.parentStartLine,
    matchedLineCount: candidate.matchedLineCount,
    distinctiveLineCount: candidate.distinctiveLineCount,
    alphanumericCount: candidate.alphanumericCount,
    comparison: "exact-lines",
  };
}

export function proveDeclarationCorrespondence(
  input: DeclarationCorrespondenceProofInput,
): DeclarationCorrespondenceProofResult {
  if (input.exactEstablished) {
    return uncertain(
      "exact-already-established",
      "Exact ancestry already succeeded; transformed evidence cannot replace it.",
    );
  }
  if (!input.childComplete || !input.parentComplete) {
    return unavailable(
      "incomplete-material",
      "Required child or parent declaration material was incomplete.",
    );
  }

  const covering = input.childDeclarations.filter((value) => containsLine(value, input.queriedChildLine));
  if (covering.length === 0) {
    return uncertain("no-child-declaration", "The queried line is not inside a supported declaration.");
  }
  const smallest = Math.min(...covering.map(spanLength));
  const innermost = covering.filter((value) => spanLength(value) === smallest);
  if (innermost.length !== 1) {
    return uncertain("ambiguous-child-declaration", "More than one innermost supported declaration covers the queried line.");
  }
  const child = innermost[0] as DeclarationFact;
  if (spanLength(child) > MAX_DECLARATION_LINES) {
    return unavailable("declaration-too-large", "The child declaration exceeds the 200-line correspondence limit.");
  }

  const matching = input.parentDeclarations.filter((value) => sameKey(child, value));
  if (matching.length === 0) {
    return uncertain("no-parent-declaration", "The selected parent has no declaration with the identical frozen syntactic key.");
  }
  if (matching.length !== 1) {
    return uncertain("ambiguous-parent-declaration", "The selected parent has multiple declarations with the identical frozen syntactic key.");
  }
  const parent = matching[0] as DeclarationFact;
  if (spanLength(parent) > MAX_DECLARATION_LINES) {
    return unavailable("declaration-too-large", "The parent declaration exceeds the 200-line correspondence limit.");
  }

  const hunk = hunkProof(input, child, parent);
  if (hunk === "ambiguous") {
    return uncertain("ambiguous-hunk", "More than one qualifying edit hunk connected the declaration pair.");
  }
  if (hunk === "incomplete") {
    return unavailable("incomplete-material", "The qualifying edit hunk was truncated; declaration correspondence was not proven.");
  }
  if (hunk === null) {
    return uncertain("disconnected-hunk", "The queried added line and declaration regions were not connected by one edit hunk.");
  }
  if (input.childText.slice(child.startOffset, child.endOffset) === input.parentText.slice(parent.startOffset, parent.endOffset)) {
    return uncertain("identical-declaration", "The declaration texts are byte-for-byte identical; no transformed proof is needed.");
  }

  const anchor = findAnchor(input, child, parent);
  if (anchor === "work-bound") {
    return unavailable("comparison-work-bound", "The declaration anchor comparison exceeded 40,000 exact line-pair checks.");
  }
  if (anchor === "ambiguous") {
    return uncertain("ambiguous-anchor", "More than one uniquely aligned exact declaration anchor met the strength floor.");
  }
  if (anchor === "insufficient") {
    return uncertain("insufficient-anchor", "No uniquely aligned exact declaration anchor met two distinctive lines and 40 alphanumeric characters.");
  }

  return {
    status: "transformed",
    relationship: "direct-parent-declaration",
    childDeclaration: descriptor(child),
    parentDeclaration: descriptor(parent),
    hunk,
    anchor,
    limitations: [
      "This is a verified direct-parent declaration correspondence, not exact line ancestry.",
      "The queried line itself is not proven to have existed in the selected parent.",
    ],
  };
}
