import { TextDecoder } from "node:util";

import { proveExactBlock } from "../ancestry/exact-block-proof.js";
import type {
  ExactBlockProof,
  ExactTransitionKind,
} from "../ancestry/model.js";
import type {
  GitBlameAttribution,
  GitPathChange,
  RepositoryContext,
  ResolvedRangeCodeLocation,
} from "../provenance/model.js";
import type {
  RangeAncestryCoverage,
  RangeAncestrySegment,
  RangeLineAttribution,
  RangeTextualGroup,
} from "../provenance/range-model.js";
import { OperationalError } from "../whyline-error.js";
import { decodeGitUtf8, type GitResult, type GitRunner } from "./git-process.js";
import { parseBlamePorcelainRange } from "./blame-range.js";

const GIT_OBJECT_ID = /^[0-9a-fA-F]{7,128}$/;

interface BlobMaterial {
  readonly lines: readonly string[];
  readonly complete: true;
}

interface TreeBlob {
  readonly objectId: string;
  readonly path: string;
}

interface CandidateRecord {
  readonly sourceLine: number;
  readonly fact: RangeLineAttribution;
  readonly blame: GitBlameAttribution;
}

interface CandidateRun {
  readonly records: readonly CandidateRecord[];
}

type MaterialFailure = "missing-history" | "unsupported-object";

interface LineOutcome {
  readonly status: RangeAncestrySegment["status"];
  readonly candidate?: CandidateRecord["blame"] | undefined;
  readonly ancestor?: {
    readonly commitId: string;
    readonly path: string;
    readonly line: number;
  } | undefined;
  readonly ancestorSubject?: string | undefined;
  readonly transition?: ExactTransitionKind | undefined;
  readonly proof?: ExactBlockProof | undefined;
  readonly limitations: readonly string[];
}

function isObjectId(value: string): boolean {
  return GIT_OBJECT_ID.test(value);
}

function shallowFailure(context: RepositoryContext): MaterialFailure {
  return context.isShallow ? "missing-history" : "unsupported-object";
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
    throw new OperationalError(operation + " could not start: " + detail);
  }
}

function parseBlobLines(value: Buffer): readonly string[] | null {
  if (value.includes(0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    return lines;
  } catch {
    return null;
  }
}

function parseTreeBlob(value: Buffer, expectedPath: string): TreeBlob | null {
  const records = decodeGitUtf8(value)
    .split("\u0000")
    .filter((record) => record.length > 0);
  if (records.length !== 1) return null;
  const record = records[0];
  if (record === undefined) return null;
  const separator = record.indexOf("\t");
  if (separator < 0) return null;
  const metadata = record.slice(0, separator).split(" ");
  const objectId = metadata[2];
  const type = metadata[1];
  const actualPath = record.slice(separator + 1);
  if (
    type !== "blob"
    || objectId === undefined
    || actualPath !== expectedPath
    || !isObjectId(objectId)
  ) {
    return null;
  }
  return { objectId, path: actualPath };
}

async function resolveBlob(
  runner: GitRunner,
  context: RepositoryContext,
  commitId: string,
  repositoryPath: string,
): Promise<{ readonly material: BlobMaterial } | { readonly failure: MaterialFailure }> {
  if (!isObjectId(commitId) || repositoryPath.length === 0 || repositoryPath.includes("\u0000")) {
    return { failure: shallowFailure(context) };
  }
  const treeResult = await runAncestryGit(
    runner,
    ["ls-tree", "-z", "--full-tree", commitId, "--", repositoryPath],
    context.worktreeRoot,
    "ancestry tree lookup",
  );
  if (treeResult.exitCode !== 0) return { failure: shallowFailure(context) };
  const treeBlob = parseTreeBlob(treeResult.stdout, repositoryPath);
  if (treeBlob === null) return { failure: shallowFailure(context) };

  const blobResult = await runAncestryGit(
    runner,
    ["cat-file", "blob", treeBlob.objectId],
    context.worktreeRoot,
    "ancestry blob lookup",
  );
  if (blobResult.exitCode !== 0) return { failure: shallowFailure(context) };
  const lines = parseBlobLines(blobResult.stdout);
  return lines === null
    ? { failure: "unsupported-object" }
    : { material: { lines, complete: true } };
}

async function movementBlame(
  runner: GitRunner,
  context: RepositoryContext,
  group: RangeTextualGroup,
  startLine: number,
  endLine: number,
): Promise<readonly RangeLineAttribution[] | { readonly failure: MaterialFailure }> {
  if (
    group.commit === null
    || group.blamedPath === null
    || !isObjectId(group.commit.id)
    || group.blamedPath.includes("\u0000")
  ) {
    return { failure: shallowFailure(context) };
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
      startLine + "," + endLine,
      group.commit.id,
      "--",
      group.blamedPath,
    ],
    context.worktreeRoot,
    "movement-aware range Git blame",
  );
  if (result.exitCode !== 0) return { failure: shallowFailure(context) };
  return parseBlamePorcelainRange(result.stdout, group.blamedPath, startLine, endLine);
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
  return decodeGitUtf8(result.stdout).replace(/\r?\n$/, "").slice(0, 240);
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
): ExactTransitionKind {
  if (isConnectedRename(changes, sourcePath, currentPaths)) return "renamed-path";
  if (sourcePath === currentPath && ancestorLine !== currentLine) return "same-file-move";
  if (sourcePath !== currentPath) return "cross-file-move-or-copy";
  return "unclassified-exact";
}

function candidateKey(value: CandidateRecord): string {
  return value.blame.objectId + "\u0000" + value.blame.filename;
}

function makeUnavailableOutcome(
  status: "unavailable" | "none",
  message: string,
): LineOutcome {
  return { status, limitations: [message] };
}

function makeCoverage(
  group: RangeTextualGroup,
  outcomes: ReadonlyMap<number, LineOutcome>,
): RangeAncestryCoverage {
  const segments: RangeAncestrySegment[] = [];
  let active: {
    readonly startLine: number;
    readonly endLine: number;
    readonly outcome: LineOutcome;
  } | null = null;
  const sameOutcome = (left: LineOutcome, right: LineOutcome): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

  const finish = (): void => {
    if (active === null) return;
    const outcome = active.outcome;
    segments.push({
      span: { startLine: active.startLine, endLine: active.endLine },
      status: outcome.status,
      ...(outcome.candidate === undefined ? {} : {
        candidate: {
          commitId: outcome.candidate.objectId,
          path: outcome.candidate.filename,
          line: outcome.candidate.originalLine,
        },
      }),
      ...(outcome.ancestor === undefined ? {} : { ancestor: outcome.ancestor }),
      ...(outcome.ancestorSubject === undefined ? {} : { ancestorSubject: outcome.ancestorSubject }),
      ...(outcome.transition === undefined ? {} : { transition: outcome.transition }),
      ...(outcome.proof === undefined ? {} : { proof: outcome.proof }),
      limitations: outcome.limitations,
    });
    active = null;
  };

  for (const line of [...group.lines].sort((left, right) => left.queryLine - right.queryLine)) {
    const outcome = outcomes.get(line.queryLine);
    if (outcome === undefined) continue;
    if (
      active !== null
      && active.endLine + 1 === line.queryLine
      && sameOutcome(active.outcome, outcome)
    ) {
      active = {
        startLine: active.startLine,
        endLine: line.queryLine,
        outcome,
      };
    } else {
      finish();
      active = { startLine: line.queryLine, endLine: line.queryLine, outcome };
    }
  }
  finish();
  return {
    segments,
    limitations: [...new Set(segments.flatMap((segment) => segment.limitations))],
  };
}

function applyRunFailure(
  outcomes: Map<number, LineOutcome>,
  run: CandidateRun,
  status: "uncertain" | "unavailable",
  message: string,
): void {
  for (const record of run.records) {
    const existing = outcomes.get(record.fact.queryLine);
    if (existing?.status === "exact") continue;
    outcomes.set(record.fact.queryLine, {
      status,
      candidate: record.blame,
      limitations: [message],
    });
  }
}

function addProofCoverage(
  outcomes: Map<number, LineOutcome>,
  sourceToFacts: ReadonlyMap<number, readonly RangeLineAttribution[]>,
  proof: ExactBlockProof,
  record: CandidateRecord,
  subject: string,
  transition: ExactTransitionKind,
): void {
  const start = proof.currentStartLine;
  const end = start + proof.matchedLineCount - 1;
  for (let sourceLine = start; sourceLine <= end; sourceLine += 1) {
    for (const fact of sourceToFacts.get(sourceLine) ?? []) {
      outcomes.set(fact.queryLine, {
        status: "exact",
        candidate: record.blame,
        ancestor: {
          commitId: record.blame.objectId,
          path: record.blame.filename,
          line: record.blame.originalLine,
        },
        ancestorSubject: subject,
        transition,
        proof,
        limitations: [
          "Exact ancestry is limited to queried lines covered by independently verified exact proof blocks.",
        ],
      });
    }
  }
}

function candidateRuns(
  movement: readonly RangeLineAttribution[],
  sourceToFacts: ReadonlyMap<number, readonly RangeLineAttribution[]>,
  textualCommitId: string,
): readonly CandidateRun[] {
  const candidates: CandidateRecord[] = [];
  for (const attribution of movement) {
    if (attribution.blame.uncommitted) continue;
    if (attribution.blame.objectId.toLowerCase() === textualCommitId.toLowerCase()) continue;
    const facts = sourceToFacts.get(attribution.queryLine);
    if (facts === undefined) continue;
    for (const fact of facts) {
      candidates.push({
        sourceLine: attribution.queryLine,
        fact,
        blame: attribution.blame,
      });
    }
  }
  candidates.sort((left, right) => left.sourceLine - right.sourceLine);
  const runs: CandidateRun[] = [];
  for (const candidate of candidates) {
    const previousRun = runs[runs.length - 1];
    const previous = previousRun?.records[previousRun.records.length - 1];
    if (
      previousRun !== undefined
      && previous !== undefined
      && candidateKey(previous) === candidateKey(candidate)
      && previous.sourceLine + 1 === candidate.sourceLine
      && previous.blame.originalLine + 1 === candidate.blame.originalLine
    ) {
      runs[runs.length - 1] = { records: [...previousRun.records, candidate] };
    } else {
      runs.push({ records: [candidate] });
    }
  }
  return runs;
}

async function analyzeRun(
  runner: GitRunner,
  context: RepositoryContext,
  location: ResolvedRangeCodeLocation,
  group: RangeTextualGroup,
  run: CandidateRun,
  sourceToFacts: ReadonlyMap<number, readonly RangeLineAttribution[]>,
  currentMaterial: BlobMaterial,
  reachabilityCache: Map<string, Promise<"yes" | "no" | "unavailable">>,
  blobCache: Map<string, Promise<{ readonly material: BlobMaterial } | { readonly failure: MaterialFailure }>>,
  subjectCache: Map<string, Promise<string | null>>,
  outcomes: Map<number, LineOutcome>,
): Promise<void> {
  const first = run.records[0];
  if (first === undefined || group.commit === null) return;
  const candidateId = first.blame.objectId;
  const reachabilityKey = candidateId + "\u0000" + group.commit.id;
  let reachability = reachabilityCache.get(reachabilityKey);
  if (reachability === undefined) {
    reachability = hasProperReachability(runner, context, candidateId, group.commit.id);
    reachabilityCache.set(reachabilityKey, reachability);
  }
  const reachable = await reachability;
  if (reachable === "unavailable") {
    applyRunFailure(outcomes, run, "unavailable", "Git could not establish proper ancestor reachability.");
    return;
  }
  if (reachable === "no") {
    applyRunFailure(outcomes, run, "uncertain", "Git suggested movement, but the candidate was not a proper reachable ancestor.");
    return;
  }

  const blobKey = candidateId + "\u0000" + first.blame.filename;
  let ancestorMaterial = blobCache.get(blobKey);
  if (ancestorMaterial === undefined) {
    ancestorMaterial = resolveBlob(runner, context, candidateId, first.blame.filename);
    blobCache.set(blobKey, ancestorMaterial);
  }
  const resolvedAncestor = await ancestorMaterial;
  if ("failure" in resolvedAncestor) {
    applyRunFailure(
      outcomes,
      run,
      "unavailable",
      resolvedAncestor.failure === "missing-history"
        ? "The candidate ancestor blob was unavailable because history is incomplete."
        : "The candidate ancestor blob required for exact ancestry was unavailable.",
    );
    return;
  }

  let subject = subjectCache.get(candidateId);
  if (subject === undefined) {
    subject = commitSubject(runner, context, candidateId);
    subjectCache.set(candidateId, subject);
  }
  const resolvedSubject = await subject;
  if (resolvedSubject === null) {
    applyRunFailure(outcomes, run, "unavailable", "The exact candidate was proven only without available commit metadata.");
    return;
  }

  for (const record of run.records) {
    const proof = proveExactBlock({
      currentLines: currentMaterial.lines,
      currentLine: record.sourceLine,
      currentComplete: currentMaterial.complete,
      ancestorLines: resolvedAncestor.material.lines,
      ancestorLine: record.blame.originalLine,
      ancestorComplete: resolvedAncestor.material.complete,
    });
    if (proof === null) {
      const currentLine = currentMaterial.lines[record.sourceLine - 1];
      const ancestorLine = resolvedAncestor.material.lines[record.blame.originalLine - 1];
      applyRunFailure(
        outcomes,
        { records: [record] },
        "uncertain",
        currentLine === ancestorLine
          ? "Git suggested movement, but the exact block lacked the required distinctive proof."
          : "Git suggested movement, but the candidate lines were not exact.",
      );
      continue;
    }
    addProofCoverage(
      outcomes,
      sourceToFacts,
      proof,
      record,
      resolvedSubject,
      classifyTransition(
        group.changedPaths,
        record.blame.filename,
        group.blamedPath ?? location.repositoryPath,
        record.sourceLine,
        record.blame.originalLine,
        new Set([location.repositoryPath, group.blamedPath ?? location.repositoryPath]),
      ),
    );
  }
}

export async function traceRangeGroupAncestry(
  runner: GitRunner,
  context: RepositoryContext,
  location: ResolvedRangeCodeLocation,
  group: RangeTextualGroup,
): Promise<RangeAncestryCoverage> {
  const outcomes = new Map<number, LineOutcome>();
  for (const fact of group.lines) {
    outcomes.set(fact.queryLine, {
      status: "none",
      limitations: ["No earlier exact ancestry was established for this queried line."],
    });
  }

  if (group.state !== "committed" || group.commit === null || group.blamedPath === null) {
    for (const fact of group.lines) {
      outcomes.set(fact.queryLine, makeUnavailableOutcome(
        "unavailable",
        "Exact ancestry requires committed baseline Git attribution.",
      ));
    }
    return makeCoverage(group, outcomes);
  }
  if (group.parent?.kind === "ambiguous") {
    for (const fact of group.lines) {
      outcomes.set(fact.queryLine, makeUnavailableOutcome(
        "unavailable",
        "The textual attribution has an unresolved merge parent; no ancestry parent was invented.",
      ));
    }
    return makeCoverage(group, outcomes);
  }
  if (context.isShallow && group.parent?.kind === "unavailable") {
    for (const fact of group.lines) {
      outcomes.set(fact.queryLine, makeUnavailableOutcome(
        "unavailable",
        "The shallow repository does not establish a complete parent history for ancestry.",
      ));
    }
    return makeCoverage(group, outcomes);
  }
  if (!context.isShallow && group.commit.parents.length === 0) {
    for (const fact of group.lines) {
      outcomes.set(fact.queryLine, makeUnavailableOutcome(
        "none",
        "The textual attribution is the visible history root; no semantic origin was inferred.",
      ));
    }
    return makeCoverage(group, outcomes);
  }

  const sourceLines = group.lines.map((fact) => fact.blame.originalLine);
  const startLine = Math.min(...sourceLines);
  const endLine = Math.max(...sourceLines);
  const movement = await movementBlame(runner, context, group, startLine, endLine);
  if ("failure" in movement) {
    const message = movement.failure === "missing-history"
      ? "Movement-aware ancestry could not be established because shallow history is incomplete."
      : "Movement-aware ancestry could not be established because required Git material was unavailable.";
    for (const fact of group.lines) {
      outcomes.set(fact.queryLine, makeUnavailableOutcome("unavailable", message));
    }
    return makeCoverage(group, outcomes);
  }

  const sourceToFacts = new Map<number, RangeLineAttribution[]>();
  for (const fact of group.lines) {
    const existing = sourceToFacts.get(fact.blame.originalLine);
    if (existing === undefined) {
      sourceToFacts.set(fact.blame.originalLine, [fact]);
    } else {
      existing.push(fact);
    }
  }
  const runs = candidateRuns(movement, sourceToFacts, group.commit.id);
  if (runs.length === 0) return makeCoverage(group, outcomes);

  const reachabilityCache = new Map<string, Promise<"yes" | "no" | "unavailable">>();
  const blobCache = new Map<string, Promise<{ readonly material: BlobMaterial } | { readonly failure: MaterialFailure }>>();
  const subjectCache = new Map<string, Promise<string | null>>();
  const currentKey = group.commit.id + "\u0000" + group.blamedPath;
  let currentMaterialPromise = blobCache.get(currentKey);
  if (currentMaterialPromise === undefined) {
    currentMaterialPromise = resolveBlob(runner, context, group.commit.id, group.blamedPath);
    blobCache.set(currentKey, currentMaterialPromise);
  }
  const currentMaterialResult = await currentMaterialPromise;
  if ("failure" in currentMaterialResult) {
    const message = currentMaterialResult.failure === "missing-history"
      ? "The textual commit blob was unavailable because history is incomplete."
      : "The textual commit blob required for exact ancestry was unavailable.";
    for (const fact of group.lines) {
      outcomes.set(fact.queryLine, makeUnavailableOutcome("unavailable", message));
    }
    return makeCoverage(group, outcomes);
  }

  for (const run of runs) {
    await analyzeRun(
      runner,
      context,
      location,
      group,
      run,
      sourceToFacts,
      currentMaterialResult.material,
      reachabilityCache,
      blobCache,
      subjectCache,
      outcomes,
    );
  }
  return makeCoverage(group, outcomes);
}
