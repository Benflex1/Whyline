import type {
  ExactBlockProof,
  GitAncestryResult,
  GitLineAncestor,
} from "../ancestry/model.js";
import { proveExactBlock } from "../ancestry/exact-block-proof.js";
import type {
  GitBlameAttribution,
  GitProvenance,
  GitPathChange,
  RepositoryContext,
  ResolvedCodeLocation,
} from "../provenance/model.js";
import { parseBlamePorcelain } from "./blame-line.js";
import {
  decodeGitUtf8,
  type GitResult,
  type GitRunner,
} from "./git-process.js";
import { OperationalError } from "../whyline-error.js";

const GIT_OBJECT_ID = /^[0-9a-fA-F]{7,128}$/;
const MAX_SUBJECT_LENGTH = 240;

interface BlobMaterial {
  readonly lines: readonly string[];
  readonly complete: true;
}

interface TreeBlob {
  readonly objectId: string;
  readonly path: string;
}

function limitation(value: string): string[] {
  return [value];
}

function unavailable(
  reason: "ambiguous-parent" | "missing-history" | "unsupported-object",
  message: string,
  candidate?: GitLineAncestor,
): GitAncestryResult {
  return candidate === undefined
    ? { status: "unavailable", reason, limitations: limitation(message) }
    : { status: "unavailable", reason, candidate, limitations: limitation(message) };
}

function isObjectId(value: string): boolean {
  return GIT_OBJECT_ID.test(value);
}

async function runAncestryGit(
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
  operation: string,
): Promise<GitResult> {
  try {
    return await runner.run(args, { cwd });
  } catch (error: unknown) {
    if (error instanceof OperationalError) throw error;
    const detail = error instanceof Error ? error.message : "unknown process error";
    throw new OperationalError(`${operation} could not start: ${detail}`);
  }
}

function shallowOrUnsupported(
  context: RepositoryContext,
): "missing-history" | "unsupported-object" {
  return context.isShallow ? "missing-history" : "unsupported-object";
}

function parseBlobLines(value: Buffer): readonly string[] | null {
  if (value.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function parseTreeBlob(value: Buffer, expectedPath: string): TreeBlob | null {
  const records = decodeGitUtf8(value).split("\u0000").filter((record) => record.length > 0);
  if (records.length !== 1) return null;
  const separator = records[0]?.indexOf("\t") ?? -1;
  if (separator < 0) return null;
  const metadata = records[0]?.slice(0, separator).split(" ") ?? [];
  const objectId = metadata[2];
  const type = metadata[1];
  const actualPath = records[0]?.slice(separator + 1);
  if (type !== "blob" || objectId === undefined || actualPath !== expectedPath || !isObjectId(objectId)) {
    return null;
  }
  return { objectId, path: actualPath };
}

async function resolveBlob(
  runner: GitRunner,
  context: RepositoryContext,
  commitId: string,
  repositoryPath: string,
): Promise<{ readonly material: BlobMaterial } | { readonly failure: "missing-history" | "unsupported-object" }> {
  if (!isObjectId(commitId) || repositoryPath.length === 0 || repositoryPath.includes("\u0000")) {
    return { failure: shallowOrUnsupported(context) };
  }

  const treeResult = await runAncestryGit(
    runner,
    ["ls-tree", "-z", "--full-tree", commitId, "--", repositoryPath],
    context.worktreeRoot,
    "ancestry tree lookup",
  );
  if (treeResult.exitCode !== 0) {
    return { failure: shallowOrUnsupported(context) };
  }
  const treeBlob = parseTreeBlob(treeResult.stdout, repositoryPath);
  if (treeBlob === null) {
    return { failure: shallowOrUnsupported(context) };
  }

  const blobResult = await runAncestryGit(
    runner,
    ["cat-file", "blob", treeBlob.objectId],
    context.worktreeRoot,
    "ancestry blob lookup",
  );
  if (blobResult.exitCode !== 0) {
    return { failure: shallowOrUnsupported(context) };
  }
  const lines = parseBlobLines(blobResult.stdout);
  return lines === null
    ? { failure: "unsupported-object" }
    : { material: { lines, complete: true } };
}

async function movementBlame(
  runner: GitRunner,
  context: RepositoryContext,
  blame: GitBlameAttribution,
): Promise<{ readonly attribution: GitBlameAttribution } | { readonly failure: "missing-history" | "unsupported-object" }> {
  if (!isObjectId(blame.objectId) || blame.filename.includes("\u0000")) {
    return { failure: shallowOrUnsupported(context) };
  }
  const result = await runAncestryGit(
    runner,
    [
      "-c",
      "core.quotePath=false",
      "-c",
      "color.ui=false",
      "blame",
      "--line-porcelain",
      "-M",
      "-C",
      "-L",
      `${blame.originalLine},${blame.originalLine}`,
      blame.objectId,
      "--",
      blame.filename,
    ],
    context.worktreeRoot,
    "movement-aware Git blame",
  );
  if (result.exitCode !== 0) {
    return { failure: shallowOrUnsupported(context) };
  }
  return { attribution: parseBlamePorcelain(result.stdout, blame.filename) };
}

async function hasProperReachability(
  runner: GitRunner,
  context: RepositoryContext,
  candidateId: string,
  textualId: string,
): Promise<"yes" | "no" | "unavailable"> {
  if (!isObjectId(candidateId) || !isObjectId(textualId)) return "unavailable";
  if (candidateId.toLowerCase() === textualId.toLowerCase()) return "no";
  const result = await runAncestryGit(
    runner,
    ["merge-base", "--is-ancestor", candidateId, textualId],
    context.worktreeRoot,
    "ancestry reachability check",
  );
  if (result.exitCode === 0) return "yes";
  if (result.exitCode === 1) return "no";
  return "unavailable";
}

async function commitSubject(
  runner: GitRunner,
  context: RepositoryContext,
  commitId: string,
): Promise<string | null> {
  if (!isObjectId(commitId)) return null;
  const result = await runAncestryGit(
    runner,
    ["show", "-s", "--no-color", "--format=%s", commitId],
    context.worktreeRoot,
    "ancestry commit metadata lookup",
  );
  if (result.exitCode !== 0) return null;
  return decodeGitUtf8(result.stdout).replace(/\r?\n$/, "").slice(0, MAX_SUBJECT_LENGTH);
}

function isConnectedRename(
  changes: readonly GitPathChange[],
  sourcePath: string,
  currentPaths: ReadonlySet<string>,
): boolean {
  return changes.some((change) =>
    change.kind === "renamed"
    && change.oldPath === sourcePath
    && change.newPath !== null
    && currentPaths.has(change.newPath));
}

function classifyTransition(
  changes: readonly GitPathChange[],
  sourcePath: string,
  currentPath: string,
  currentLine: number,
  ancestorLine: number,
  currentPaths: ReadonlySet<string>,
): "same-file-move" | "cross-file-move-or-copy" | "renamed-path" | "unclassified-exact" {
  if (isConnectedRename(changes, sourcePath, currentPaths)) return "renamed-path";
  if (sourcePath === currentPath && ancestorLine !== currentLine) return "same-file-move";
  if (sourcePath !== currentPath) return "cross-file-move-or-copy";
  return "unclassified-exact";
}

function exactResult(
  context: RepositoryContext,
  changes: readonly GitPathChange[],
  location: ResolvedCodeLocation,
  sourcePath: string,
  currentPath: string,
  currentLine: number,
  candidate: GitLineAncestor,
  proof: ExactBlockProof,
  subject: string,
): GitAncestryResult {
  const currentPaths = new Set([currentPath, location.repositoryPath]);
  const transition = classifyTransition(
    changes,
    sourcePath,
    currentPath,
    currentLine,
    candidate.line,
    currentPaths,
  );
  const limitations = [
    "Exact ancestry is limited to the visible Git history and does not establish semantic origin.",
  ];
  if (context.isShallow) {
    limitations.push("The repository is shallow; the exact predecessor is visible but may not be the earliest ancestor.");
  }
  return {
    status: "exact",
    relationship: "exact-ancestor",
    transition,
    ancestor: candidate,
    ancestorSubject: subject,
    proof,
    limitations,
  };
}

export async function traceLineAncestry(
  runner: GitRunner,
  context: RepositoryContext,
  location: ResolvedCodeLocation,
  provenance: GitProvenance,
): Promise<GitAncestryResult> {
  if (provenance.state !== "committed" || provenance.commit === null || provenance.blame === null) {
    return unavailable("unsupported-object", "Exact ancestry requires committed baseline Git attribution.");
  }
  if (provenance.parent?.kind === "ambiguous") {
    return unavailable("ambiguous-parent", "The textual attribution has an unresolved merge parent; no ancestry parent was invented.");
  }
  if (context.isShallow && provenance.parent?.kind === "unavailable") {
    return unavailable("missing-history", "The shallow repository does not establish a complete parent history for ancestry.");
  }
  if (!context.isShallow && provenance.commit.parents.length === 0) {
    return {
      status: "none",
      reason: "root-history-boundary",
      limitations: ["The textual attribution is the visible history root; no semantic origin was inferred."],
    };
  }

  const movement = await movementBlame(runner, context, provenance.blame);
  if ("failure" in movement) {
    return unavailable(
      movement.failure,
      movement.failure === "missing-history"
        ? "Movement-aware ancestry could not be established because shallow history is incomplete."
        : "Movement-aware ancestry could not be established because required Git material was unavailable.",
    );
  }
  const candidateBlame = movement.attribution;
  if (candidateBlame.uncommitted || candidateBlame.objectId.toLowerCase() === provenance.commit.id.toLowerCase()) {
    return context.isShallow
      ? unavailable("missing-history", "The shallow history provided no complete older movement/copy attribution.")
      : {
          status: "none",
          reason: "no-earlier-move-copy-attribution",
          limitations: ["Git did not identify an older movement/copy attribution for the queried line."],
        };
  }

  const candidate = {
    commitId: candidateBlame.objectId,
    path: candidateBlame.filename,
    line: candidateBlame.originalLine,
  } satisfies GitLineAncestor;
  const reachability = await hasProperReachability(
    runner,
    context,
    candidate.commitId,
    provenance.commit.id,
  );
  if (reachability === "unavailable") {
    return unavailable(
      shallowOrUnsupported(context),
      context.isShallow
        ? "The shallow history could not establish proper reachability for the movement candidate."
        : "Git could not establish proper reachability for the movement candidate.",
      candidate,
    );
  }
  if (reachability === "no") {
    return {
      status: "uncertain",
      reason: "candidate-not-exact",
      candidate,
      limitations: ["Git suggested a candidate, but it was not a proper reachable ancestor of the textual attribution."],
    };
  }

  const currentPath = provenance.blame.filename;
  const currentMaterial = await resolveBlob(runner, context, provenance.commit.id, currentPath);
  if ("failure" in currentMaterial) {
    return unavailable(currentMaterial.failure, "The textual commit blob required for exact ancestry was unavailable.", candidate);
  }
  const ancestorMaterial = await resolveBlob(runner, context, candidate.commitId, candidate.path);
  if ("failure" in ancestorMaterial) {
    return unavailable(ancestorMaterial.failure, "The candidate ancestor blob required for exact ancestry was unavailable.", candidate);
  }

  const currentLine = provenance.blame.originalLine;
  const exactLineMatch = currentMaterial.material.lines[currentLine - 1] === ancestorMaterial.material.lines[candidate.line - 1];
  const proof = proveExactBlock({
    currentLines: currentMaterial.material.lines,
    currentLine,
    currentComplete: currentMaterial.material.complete,
    ancestorLines: ancestorMaterial.material.lines,
    ancestorLine: candidate.line,
    ancestorComplete: ancestorMaterial.material.complete,
  });
  if (proof === null) {
    return {
      status: "uncertain",
      reason: exactLineMatch ? "insufficient-distinctive-context" : "candidate-not-exact",
      candidate,
      limitations: [
        exactLineMatch
          ? "Git suggested movement, but the exact block lacked two unique distinctive lines or 40 alphanumeric characters."
          : "Git suggested movement, but the candidate and textual blocks were not exact at the anchored line.",
      ],
    };
  }

  const subject = await commitSubject(runner, context, candidate.commitId);
  if (subject === null) {
    return unavailable(
      shallowOrUnsupported(context),
      "The exact block was proven, but required ancestor commit metadata was unavailable.",
      candidate,
    );
  }
  return exactResult(
    context,
    provenance.changedPaths,
    location,
    candidate.path,
    currentPath,
    currentLine,
    candidate,
    proof,
    subject,
  );
}
