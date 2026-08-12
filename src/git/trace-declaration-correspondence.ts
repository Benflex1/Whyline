import type {
  DeclarationCorrespondenceProofResult,
} from "../ancestry/declaration-correspondence-proof.js";
import {
  declarationAttemptIdentity,
  proveDeclarationCorrespondence,
} from "../ancestry/declaration-correspondence-proof.js";
import type {
  GitAncestryResult,
} from "../ancestry/model.js";
import type {
  GitBlameAttribution,
  GitCommit,
  GitHunk,
  GitPathChange,
  GitProvenance,
  ParentSelection,
  RepositoryContext,
} from "../provenance/model.js";
import { InvalidInputError, OperationalError } from "../whyline-error.js";
import type { DeclarationIndex } from "../symbol/model.js";
import { parseDeclarationIndex, supportedDialectForPath } from "../symbol/declaration-index.js";
import { loadAncestryBlob, type AncestryBlobResult, type AncestryMaterialFailure } from "./ancestry-material.js";
import type { GitRunner } from "./git-process.js";

const MAX_HISTORICAL_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_DECLARATION_ATTEMPTS = 12;

type CommittedParent = Extract<ParentSelection, { readonly kind: "commit" }>;

export interface DeclarationCorrespondenceTraceCache {
  readonly blobs: Map<string, Promise<AncestryBlobResult>>;
  readonly indexes: Map<string, Promise<DeclarationIndex>>;
  readonly attempts: Set<string>;
}

export function createDeclarationCorrespondenceTraceCache(): DeclarationCorrespondenceTraceCache {
  return {
    blobs: new Map(),
    indexes: new Map(),
    attempts: new Set(),
  };
}

export interface DeclarationCorrespondenceTraceLineInput {
  readonly textualCommit: GitCommit;
  readonly parent: CommittedParent;
  readonly blame: GitBlameAttribution;
  readonly changedPaths: readonly GitPathChange[];
  readonly relevantHunks: readonly GitHunk[];
  readonly childLine: number;
}

function unavailable(
  reason: "missing-history" | "unsupported-object" | "work-bound",
  message: string,
): GitAncestryResult {
  return { status: "unavailable", reason, limitations: [message] };
}

function uncertain(
  reason: "insufficient-declaration-correspondence" | "ambiguous-declaration-correspondence",
  message: string,
): GitAncestryResult {
  return { status: "uncertain", reason, limitations: [message] };
}

function parentPathFor(
  childPath: string,
  changes: readonly GitPathChange[],
): string | undefined {
  const connected = changes.filter((change) =>
    change.kind === "renamed"
    && change.newPath === childPath
    && change.oldPath !== null);
  if (connected.length > 1) return undefined;
  const rename = connected[0];
  return rename?.oldPath ?? childPath;
}

function supportedPath(path: string): boolean {
  try {
    supportedDialectForPath(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof InvalidInputError) return false;
    throw error;
  }
}

function materialFailure(
  value: AncestryMaterialFailure,
  subject: string,
): GitAncestryResult {
  if (value === "work-bound") return unavailable("work-bound", subject + " exceeded the 2 MiB historical blob limit.");
  if (value === "missing-history") return unavailable("missing-history", subject + " was unavailable because shallow history is incomplete.");
  return unavailable("unsupported-object", subject + " was binary, invalid UTF-8, or otherwise unreadable.");
}

function proofResult(
  value: DeclarationCorrespondenceProofResult,
  input: DeclarationCorrespondenceTraceLineInput,
  childPath: string,
  parentPath: string,
): GitAncestryResult {
  if (value.status === "transformed") {
    return {
      status: "transformed",
      relationship: "direct-parent-declaration",
      textualCommitId: input.textualCommit.id,
      parentCommitId: input.parent.commitId,
      childPath,
      parentPath,
      childDeclaration: value.childDeclaration,
      parentDeclaration: value.parentDeclaration,
      parentSelectionEvidence: input.parent.evidence,
      hunk: value.hunk,
      anchor: value.anchor,
      limitations: value.limitations,
    };
  }
  if (value.status === "unavailable") {
    return unavailable(
      value.reason === "comparison-work-bound" ? "work-bound" : "unsupported-object",
      value.limitations[0] ?? "Declaration correspondence material was unavailable.",
    );
  }
  return uncertain(
    value.reason.includes("ambiguous")
      ? "ambiguous-declaration-correspondence"
      : "insufficient-declaration-correspondence",
    value.limitations[0] ?? "Declaration correspondence was not uniquely established.",
  );
}

async function blob(
  runner: GitRunner,
  context: RepositoryContext,
  cache: DeclarationCorrespondenceTraceCache,
  commitId: string,
  repositoryPath: string,
): Promise<AncestryBlobResult> {
  const key = commitId + "\u0000" + repositoryPath;
  let result = cache.blobs.get(key);
  if (result === undefined) {
    result = loadAncestryBlob(runner, context, commitId, repositoryPath, {
      maxBytes: MAX_HISTORICAL_BLOB_BYTES,
    });
    cache.blobs.set(key, result);
  }
  return result;
}

async function index(
  cache: DeclarationCorrespondenceTraceCache,
  repositoryPath: string,
  material: Extract<AncestryBlobResult, { readonly material: unknown }>["material"],
): Promise<DeclarationIndex> {
  const key = material.text + "\u0000" + repositoryPath;
  let result = cache.indexes.get(key);
  if (result === undefined) {
    result = parseDeclarationIndex(repositoryPath, material.text, { maxDeclarations: 512 });
    cache.indexes.set(key, result);
  }
  return result;
}

async function traceLine(
  runner: GitRunner,
  context: RepositoryContext,
  input: DeclarationCorrespondenceTraceLineInput,
  cache: DeclarationCorrespondenceTraceCache,
): Promise<GitAncestryResult | null> {
  const childPath = input.blame.filename;
  const parentPath = parentPathFor(childPath, input.changedPaths);
  if (parentPath === undefined || !supportedPath(childPath) || !supportedPath(parentPath)) return null;

  const childMaterial = await blob(runner, context, cache, input.textualCommit.id, childPath);
  if ("absent" in childMaterial) return null;
  if ("failure" in childMaterial) return materialFailure(childMaterial.failure, "The textual declaration blob");
  const parentMaterial = await blob(runner, context, cache, input.parent.commitId, parentPath);
  if ("absent" in parentMaterial) return null;
  if ("failure" in parentMaterial) return materialFailure(parentMaterial.failure, "The selected parent declaration blob");

  let childIndex: DeclarationIndex;
  let parentIndex: DeclarationIndex;
  try {
    childIndex = await index(cache, childPath, childMaterial.material);
    parentIndex = await index(cache, parentPath, parentMaterial.material);
  } catch (error: unknown) {
    if (error instanceof OperationalError) {
      return error.message.includes("512")
        ? unavailable("work-bound", "Historical declaration parsing exceeded the 512-declaration limit.")
        : unavailable("unsupported-object", "Historical declaration syntax or parser material was unavailable.");
    }
    if (error instanceof InvalidInputError) {
      return unavailable("unsupported-object", "Historical declaration syntax was invalid; no correspondence was inferred.");
    }
    throw error;
  }

  const attemptIdentity = [
    input.textualCommit.id,
    input.parent.commitId,
    childPath,
    parentPath,
    declarationAttemptIdentity(childIndex.declarations, input.childLine),
  ].join("\u0000");
  if (!cache.attempts.has(attemptIdentity)) {
    if (cache.attempts.size >= MAX_DECLARATION_ATTEMPTS) {
      return unavailable("work-bound", "Declaration correspondence attempt 13 was omitted by the 12-attempt invocation limit.");
    }
    cache.attempts.add(attemptIdentity);
  }

  const proof = proveDeclarationCorrespondence({
    childText: childMaterial.material.text,
    parentText: parentMaterial.material.text,
    childLines: childMaterial.material.lines,
    parentLines: parentMaterial.material.lines,
    childComplete: childMaterial.material.complete,
    parentComplete: parentMaterial.material.complete,
    childDeclarations: childIndex.declarations,
    parentDeclarations: parentIndex.declarations,
    queriedChildLine: input.childLine,
    hunks: input.relevantHunks,
    exactEstablished: false,
  });
  return proofResult(proof, input, childPath, parentPath);
}

export async function traceDeclarationCorrespondenceLine(
  runner: GitRunner,
  context: RepositoryContext,
  input: DeclarationCorrespondenceTraceLineInput,
  cache: DeclarationCorrespondenceTraceCache = createDeclarationCorrespondenceTraceCache(),
): Promise<GitAncestryResult | null> {
  return traceLine(runner, context, input, cache);
}

export async function traceDeclarationCorrespondence(
  runner: GitRunner,
  context: RepositoryContext,
  provenance: GitProvenance,
  cache: DeclarationCorrespondenceTraceCache = createDeclarationCorrespondenceTraceCache(),
): Promise<GitAncestryResult | null> {
  if (
    provenance.state !== "committed"
    || provenance.commit === null
    || provenance.blame === null
    || provenance.parent?.kind !== "commit"
  ) {
    return null;
  }
  if (provenance.commit.parents.length === 0) return null;
  return traceLine(runner, context, {
    textualCommit: provenance.commit,
    parent: provenance.parent,
    blame: provenance.blame,
    changedPaths: provenance.changedPaths,
    relevantHunks: provenance.relevantHunks,
    childLine: provenance.blame.originalLine,
  }, cache);
}
