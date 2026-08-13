import { realpath, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

import type {
  AgentCommitReferenceKind,
  AgentDiagnostic,
  AgentEvidenceBundle,
  AgentHistoryDiscoveryContext,
  AgentHistoryDiscoveryResult,
  AgentHistorySource,
  AgentSummaryRelevanceScan,
  AgentSessionRef,
  AgentSessionSummary,
  AgentEvidenceTarget,
  AgentWorktreeIdentity,
} from "../agents/agent-history-source.js";
import { CodexHistorySource } from "../agents/codex/source.js";
import {
  buildCandidateInput,
  classifyStrongPossibility,
  type CandidateBuildRequest,
} from "../correlation/build-candidates.js";
import { correlate } from "../correlation/correlate.js";
import { correlateWorktree } from "../correlation/correlate-worktree.js";
import type {
  CorrelationCandidateInput,
  CorrelationLimitation,
  CorrelationRepositoryMatch,
  CorrelationResult,
  CorrelationTarget,
  ProvenanceCorrelationTarget,
  WorktreeCorrelationTarget,
  CandidateStrongPossibility,
  ResolvedCommitReference,
} from "../correlation/model.js";
import type { GitResult, GitRunner } from "../git/git-process.js";
import {
  BoundedWorkPool,
  GitWorkGate,
  defaultCorrelationWorkLimits,
  type BoundedWorkStats,
  type CorrelationWorkLimits,
} from "./bounded-work-pool.js";
import {
  CorrelationTelemetry,
  type CorrelationMetricName,
} from "./correlation-telemetry.js";
import { isWithinDirectory } from "../git/repository-context.js";
import type {
  RepositoryContext,
  ResolvedCodeLocation,
} from "./model.js";
import { resolveCommitReference } from "./resolve-commit-reference.js";
import { OperationalError } from "../whyline-error.js";

const MAX_FULL_EVIDENCE_CANDIDATES = 32;

interface RawReference {
  readonly kind: AgentCommitReferenceKind;
  readonly reference: string;
}

interface SummaryCandidate {
  readonly ref: AgentSessionRef;
  readonly scan: AgentSummaryRelevanceScan;
  readonly summary: AgentSessionSummary;
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly pathMapping: HistoricalPathMapping | null;
  readonly cwdlessResolution: HistoricalDirectoryResolution | null;
  readonly references: readonly ResolvedCommitReference[];
  readonly input: CorrelationCandidateInput;
  readonly possibility: CandidateStrongPossibility;
}

interface PreparedCodexCandidate {
  readonly ref: AgentSessionRef;
  readonly scan: AgentSummaryRelevanceScan;
  readonly summary: AgentSessionSummary;
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly pathMapping: HistoricalPathMapping | null;
  readonly cwdlessResolution: HistoricalDirectoryResolution | null;
  readonly coverageLimitations: readonly CorrelationLimitation[];
  readonly pathClassificationComplete: boolean;
}

export interface PrepareCodexEvidenceOptions {
  readonly repository: RepositoryContext;
  readonly git: GitRunner;
  readonly agentHistorySource?: AgentHistorySource;
  readonly codexHome?: string;
  readonly workLimits?: Partial<CorrelationWorkLimits>;
}

export interface PreparedCodexEvidence {
  readonly source: AgentHistorySource;
  readonly repository: RepositoryContext;
  readonly discovery: AgentHistoryDiscoveryResult;
  readonly candidates: readonly PreparedCodexCandidate[];
  readonly coverageLimitations: readonly CorrelationLimitation[];
  readonly git: InvocationGitRunner;
  readonly limits: CorrelationWorkLimits;
}

export interface CorrelateCodexOptions {
  readonly target: CorrelationTarget;
  readonly location: ResolvedCodeLocation;
  readonly repository: RepositoryContext;
  readonly git: GitRunner;
  readonly agentHistorySource?: AgentHistorySource;
  readonly codexHome?: string;
  readonly workLimits?: Partial<CorrelationWorkLimits>;
  readonly telemetry?: CorrelationTelemetry;
}

export class InvocationGitRunner implements GitRunner {
  private readonly cache = new Map<string, Promise<GitResult>>();
  public calls = 0;

  public constructor(
    private readonly delegate: GitRunner,
    private readonly gate: GitWorkGate,
  ) {}

  public run(
    args: readonly string[],
    options: { readonly cwd: string; readonly input?: Uint8Array },
  ): Promise<GitResult> {
    if (options.input !== undefined) {
      this.calls += 1;
      return this.gate.run(() => this.delegate.run(args, options));
    }
    const key = `${options.cwd}\0${args.join("\0")}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    this.calls += 1;
    const result = this.gate.run(() => this.delegate.run(args, options));
    this.cache.set(key, result);
    return result;
  }

  public get maxObservedWorkers(): number {
    return this.gate.maxObservedWorkers;
  }
}

function limitation(
  kind: CorrelationLimitation["kind"],
  material: boolean,
  count?: number,
): CorrelationLimitation {
  return count === undefined ? { kind, material } : { kind, material, count };
}

function telemetryMetric(suffix: string): CorrelationMetricName {
  return `whyline.correlation.${suffix}` as CorrelationMetricName;
}

interface CorrelationTelemetryStages {
  readonly discoveredRefs: number;
  readonly bytesScanned: number;
  readonly scan: BoundedWorkStats;
  readonly git: BoundedWorkStats & { readonly processMsSum: number };
  readonly gitCalls: number;
  readonly projection: BoundedWorkStats;
  readonly projectedCandidates: number;
  readonly totalMs: number;
}

function recordCorrelationTelemetry(
  telemetry: CorrelationTelemetry | undefined,
  result: CorrelationResult,
  candidates: readonly SummaryCandidate[],
  stages: CorrelationTelemetryStages,
): void {
  if (telemetry === undefined) return;
  telemetry.set(telemetryMetric("discovered_refs"), stages.discoveredRefs);
  telemetry.set(telemetryMetric("bytes_scanned"), stages.bytesScanned);
  telemetry.set(telemetryMetric("summary_relevance.wall_ms"), stages.scan.wallMs);
  telemetry.set(telemetryMetric("summary_relevance.queue_ms_sum"), stages.scan.queueMsSum);
  telemetry.set(telemetryMetric("summary_relevance.queue_ms_max"), stages.scan.queueMsMax);
  telemetry.set(telemetryMetric("summary_relevance.work_ms_sum"), stages.scan.workMsSum);

  for (const candidate of candidates) {
    const category = candidate.repositoryMatch.replaceAll("-", "_");
    telemetry.add(telemetryMetric(`candidates.${category}`), 1);
    if (candidate.input.coverageLimitations.some((value) => value.kind === "unsupported-summary")) {
      telemetry.add(telemetryMetric("candidates.unsupported_summary"), 1);
    }
  }
  telemetry.set(telemetryMetric("proven_not_strong"), result.coverage.provenNotStrongRefs);
  telemetry.set(telemetryMetric("potentially_strong"), result.coverage.potentiallyStrongRefs);

  telemetry.set(telemetryMetric("git_classification.calls"), stages.gitCalls);
  telemetry.set(telemetryMetric("git_classification.wall_ms"), stages.git.wallMs);
  telemetry.set(telemetryMetric("git_classification.queue_ms_sum"), stages.git.queueMsSum);
  telemetry.set(telemetryMetric("git_classification.queue_ms_max"), stages.git.queueMsMax);
  telemetry.set(telemetryMetric("git_classification.process_ms_sum"), stages.git.processMsSum);

  telemetry.set(telemetryMetric("full_evidence.candidates"), stages.projectedCandidates);
  telemetry.set(telemetryMetric("full_evidence.bytes_read"), 0);
  telemetry.set(telemetryMetric("full_evidence.read_ms_sum"), 0);
  telemetry.set(telemetryMetric("full_evidence.wall_ms"), stages.projection.wallMs);
  telemetry.set(telemetryMetric("full_evidence.queue_ms_sum"), stages.projection.queueMsSum);
  telemetry.set(telemetryMetric("full_evidence.queue_ms_max"), stages.projection.queueMsMax);
  telemetry.set(telemetryMetric("full_evidence.work_ms_sum"), stages.projection.workMsSum);
  telemetry.set(telemetryMetric("total_ms"), stages.totalMs);

  for (const value of result.coverage.limitations) {
    if (value.material) {
      telemetry.add(telemetryMetric(`material_coverage.${value.kind}`), value.count ?? 1);
    }
  }
}

function recordEmptyCorrelationTelemetry(
  telemetry: CorrelationTelemetry | undefined,
  discoveredRefs: number,
  totalMs: number,
  result?: CorrelationResult,
): void {
  if (telemetry === undefined) return;
  telemetry.set(telemetryMetric("discovered_refs"), discoveredRefs);
  telemetry.set(telemetryMetric("total_ms"), totalMs);
  for (const value of result?.coverage.limitations ?? []) {
    if (value.material) {
      telemetry.add(telemetryMetric(`material_coverage.${value.kind}`), value.count ?? 1);
    }
  }
}

function uniqueRawReferences(references: readonly RawReference[]): readonly RawReference[] {
  const seen = new Set<string>();
  const unique: RawReference[] = [];
  for (const reference of references) {
    const key = `${reference.kind}:${reference.reference.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique;
}

function summaryReferences(summary: AgentSessionSummary): readonly RawReference[] {
  const commitHash = summary.transcriptGit?.commitHash;
  if (commitHash === undefined) return [];
  return [{
    kind: summary.transcriptGit?.referenceKind ?? "unknown",
    reference: commitHash,
  }];
}


async function resolveReferences(
  runner: GitRunner,
  repository: RepositoryContext,
  target: CorrelationTarget,
  references: readonly RawReference[],
): Promise<readonly ResolvedCommitReference[]> {
  return Promise.all(uniqueRawReferences(references).map((reference) =>
    resolveCommitReference(
      runner,
      repository,
      target.commit.id,
      reference.kind,
      reference.reference,
    )));
}

function fallbackSummary(ref: AgentSessionRef, diagnosticKind: AgentDiagnostic["kind"]): AgentSessionSummary {
  return {
    ref,
    sessionId: null,
    workingDirectories: [],
    isPartial: true,
    diagnostics: [{ kind: diagnosticKind }],
  };
}

function discoveryDiagnosticLimitations(
  diagnostics: readonly AgentDiagnostic[],
): readonly CorrelationLimitation[] {
  const counts = new Map<CorrelationLimitation["kind"], number>();
  for (const diagnostic of diagnostics) {
    const kind = diagnostic.kind === "unreadable-transcript"
      ? "discovery-limited"
      : "summary-coverage";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => limitation(kind, true, count));
}

function diagnosticLimitations(
  diagnostics: readonly AgentDiagnostic[],
): readonly CorrelationLimitation[] {
  const result: CorrelationLimitation[] = [];
  const add = (value: CorrelationLimitation): void => {
    if (!result.some((item) => item.kind === value.kind)) result.push(value);
  };
  for (const diagnostic of diagnostics) {
    switch (diagnostic.kind) {
      case "changed-during-read":
        add(limitation("changed-during-read", true));
        break;
      case "corrupt-non-final-record":
      case "partial-final-record":
      case "unreadable-transcript":
        add(limitation("corrupt-transcript", true));
        break;
      case "compacted-history":
      case "context-compaction":
      case "thread-rollback":
      case "turn-aborted":
        // Preserve the diagnostic; scoreCandidate assigns materiality after
        // direct evidence record positions are known.
        break;
      case "conflicting-session-metadata":
      case "retention-limit":
      case "unsupported-source":
      case "unlinked-tool-result":
        add(limitation("summary-coverage", true));
        break;
      default:
        break;
    }
  }
  return result;
}

const OPAQUE_SESSION_SOURCE = "<opaque-agent-session>";

interface HistoricalPathMapping {
  readonly repositoryRoot: string;
  readonly historicalCwd: string;
}

interface HistoricalDirectoryResolution {
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly pathMapping: HistoricalPathMapping | null;
}

interface RepositoryAssessment {
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly pathMapping: HistoricalPathMapping | null;
  readonly initialResolution: HistoricalDirectoryResolution;
  readonly cwdlessResolution: HistoricalDirectoryResolution | null;
}

interface ProjectedEvidencePath {
  readonly value: string | null;
  readonly incompatible: boolean;
}

interface ProjectedEvidenceResult {
  readonly evidence: AgentEvidenceBundle["evidence"][number] | null;
  readonly droppedAsIncompatible: boolean;
  readonly droppedChangeCount: number;
}

interface ProjectedEvidenceBundleResult {
  readonly bundle: AgentEvidenceBundle;
  readonly droppedIncompatibleChanges: number;
}

function projectSessionSummary(summary: AgentSessionSummary): AgentSessionSummary {
  return {
    ref: {
      adapterId: summary.ref.adapterId,
      sourcePath: OPAQUE_SESSION_SOURCE,
      sourceKind: summary.ref.sourceKind,
    },
    sessionId: summary.sessionId,
    startedAt: summary.startedAt,
    observedThroughAt: summary.observedThroughAt,
    workingDirectories: [],
    transcriptGit: summary.transcriptGit === undefined
      ? undefined
      : {
        commitHash: summary.transcriptGit.commitHash,
        referenceKind: summary.transcriptGit.referenceKind,
      },
    isPartial: summary.isPartial,
    diagnostics: summary.diagnostics,
  };
}

function relativeRepositoryPath(root: string, value: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

function targetPathAliases(target: CorrelationTarget): ReadonlySet<string> {
  const paths = new Set<string>();
  const add = (value: string | null): boolean => {
    if (value === null || paths.has(value)) return false;
    paths.add(value);
    return true;
  };

  add(target.targetPath);
  add(target.blamedPath);
  let changed = true;
  while (changed) {
    changed = false;
    for (const changedPath of target.changedPaths) {
      if ((changedPath.oldPath === null || !paths.has(changedPath.oldPath))
        && (changedPath.newPath === null || !paths.has(changedPath.newPath))) {
        continue;
      }
      changed = add(changedPath.oldPath) || changed;
      changed = add(changedPath.newPath) || changed;
    }
  }
  return paths;
}

function hasResolvedTargetAnchor(
  references: readonly ResolvedCommitReference[],
): boolean {
  return references.some((reference) =>
    reference.resolution === "target"
      && (reference.kind === "session-head" || reference.kind === "produced-commit"));
}

function evidenceDirectory(
  value: string,
  sessionInitialCwd: string | undefined,
): string | null {
  if (value === "<outside-session-root>") return null;
  if (path.isAbsolute(value)) return path.resolve(value);
  if (sessionInitialCwd === undefined || !path.isAbsolute(sessionInitialCwd)) return null;
  return path.resolve(sessionInitialCwd, value);
}

async function existingDirectoryForPath(value: string): Promise<string | null> {
  if (!path.isAbsolute(value)) return null;
  let candidate = path.resolve(value);
  try {
    const metadata = await stat(candidate);
    if (!metadata.isDirectory()) candidate = path.dirname(candidate);
  } catch {
    candidate = path.dirname(candidate);
  }

  while (true) {
    const canonical = await existingCanonicalPath(candidate);
    if (canonical !== null) return canonical;
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function resolveHistoricalPath(
  runner: GitRunner,
  repository: RepositoryContext,
  value: string,
): Promise<HistoricalDirectoryResolution | null> {
  const directory = await existingDirectoryForPath(value);
  return directory === null
    ? null
    : resolveHistoricalDirectory(runner, repository, directory);
}

async function projectEvidencePath(
  value: string,
  repository: RepositoryContext,
  runner: GitRunner,
  mapping: HistoricalPathMapping | null,
  historicalAnchorPaths: ReadonlySet<string> | null,
): Promise<ProjectedEvidencePath> {
  if (value === "<outside-session-root>" || value.length === 0) {
    return { value: null, incompatible: false };
  }

  if (path.isAbsolute(value)) {
    const pathResolution = await resolveHistoricalPath(runner, repository, value);
    if (pathResolution?.repositoryMatch === "incompatible") {
      return { value: null, incompatible: true };
    }
    if (pathResolution?.pathMapping !== null && pathResolution?.pathMapping !== undefined) {
      return {
        value: relativeRepositoryPath(pathResolution.pathMapping.repositoryRoot, value),
        incompatible: false,
      };
    }
    return {
      value: mapping === null ? null : relativeRepositoryPath(mapping.repositoryRoot, value),
      incompatible: false,
    };
  }

  if (mapping === null) {
    return historicalAnchorPaths?.has(value) === true
      ? { value, incompatible: false }
      : { value: null, incompatible: false };
  }
  const historicalPath = path.resolve(mapping.historicalCwd, value);
  const pathResolution = await resolveHistoricalPath(runner, repository, historicalPath);
  if (pathResolution?.repositoryMatch === "incompatible") {
    return { value: null, incompatible: true };
  }
  return {
    value: pathResolution?.pathMapping === null || pathResolution?.pathMapping === undefined
      ? relativeRepositoryPath(mapping.repositoryRoot, historicalPath)
      : relativeRepositoryPath(pathResolution.pathMapping.repositoryRoot, historicalPath),
    incompatible: false,
  };
}

async function projectEvidence(
  evidence: AgentEvidenceBundle["evidence"][number],
  session: AgentSessionSummary,
  repository: RepositoryContext,
  runner: GitRunner,
  cwdlessResolution: HistoricalDirectoryResolution | null,
  historicalAnchorPaths: ReadonlySet<string> | null,
): Promise<ProjectedEvidenceResult> {
  const evidenceDirectoryValue = evidence.cwd === undefined
    ? null
    : evidenceDirectory(evidence.cwd, session.initialCwd);
  const evidenceResolution = evidence.cwd === undefined
    ? cwdlessResolution
    : evidenceDirectoryValue === null
      ? { repositoryMatch: "unknown" as const, pathMapping: null }
      : await resolveHistoricalDirectory(runner, repository, evidenceDirectoryValue);
  if (evidenceResolution === null) {
    return { evidence: null, droppedAsIncompatible: false, droppedChangeCount: 0 };
  }
  if (evidenceResolution.repositoryMatch === "incompatible") {
    return {
      evidence: null,
      droppedAsIncompatible: true,
      droppedChangeCount: evidence.patch?.changes.length ?? 0,
    };
  }

  let incompatible = false;
  const projectPath = async (value: string): Promise<string | null> => {
    const projected = await projectEvidencePath(
      value,
      repository,
      runner,
      evidenceResolution.pathMapping,
      null,
    );
    incompatible ||= projected.incompatible;
    return projected.value;
  };

  const paths = (await Promise.all(evidence.paths.map(projectPath)))
    .filter((value): value is string => value !== null);
  let patch = evidence.patch;
  if (patch !== undefined) {
    const projectedChanges: Array<(typeof patch.changes)[number]> = [];
    for (const change of patch.changes) {
      const normalizedPath = await projectEvidencePath(
        change.path,
        repository,
        runner,
        evidenceResolution.pathMapping,
        historicalAnchorPaths,
      );
      incompatible ||= normalizedPath.incompatible;
      if (normalizedPath.value === null) continue;
      const normalizedMovedFrom = change.movedFrom === undefined
        ? null
        : await projectEvidencePath(
          change.movedFrom,
          repository,
          runner,
          evidenceResolution.pathMapping,
          historicalAnchorPaths,
        );
      incompatible ||= normalizedMovedFrom?.incompatible ?? false;
      if (normalizedMovedFrom?.incompatible === true) continue;
      const normalizedChange = { ...change, path: normalizedPath.value };
      if (normalizedMovedFrom === null
        || normalizedMovedFrom === undefined
        || normalizedMovedFrom.value === null) {
        delete normalizedChange.movedFrom;
        projectedChanges.push(normalizedChange);
      } else {
        projectedChanges.push({ ...normalizedChange, movedFrom: normalizedMovedFrom.value });
      }
    }
    patch = { ...patch, changes: projectedChanges };
  }

  if (incompatible) {
    return {
      evidence: null,
      droppedAsIncompatible: true,
      droppedChangeCount: evidence.patch?.changes.length ?? 0,
    };
  }
  return {
    evidence: {
      id: evidence.id,
      kind: evidence.kind,
      occurredAt: evidence.occurredAt,
      paths,
      operation: evidence.operation,
      callId: evidence.callId,
      resultRecorded: evidence.resultRecorded,
      terminalSessionId: evidence.terminalSessionId,
      reportedSuccess: evidence.reportedSuccess,
      status: evidence.status,
      patch,
      ...(evidence.worktreeIdentity === undefined
        ? {}
        : { worktreeIdentity: evidence.worktreeIdentity }),
      commitReferenceKind: evidence.commitReferenceKind,
      commitIds: evidence.commitIds,
      extraction: evidence.extraction,
      sourceRecord: evidence.sourceRecord,
    },
    droppedAsIncompatible: false,
    droppedChangeCount: 0,
  };
}

async function projectEvidenceBundle(
  bundle: AgentEvidenceBundle,
  repository: RepositoryContext,
  runner: GitRunner,
  cwdlessResolution: HistoricalDirectoryResolution | null,
  historicalAnchorPaths: ReadonlySet<string> | null,
): Promise<ProjectedEvidenceBundleResult> {
  const projected = await Promise.all(bundle.evidence.map((value) => projectEvidence(
    value,
    bundle.session,
    repository,
    runner,
    cwdlessResolution,
    historicalAnchorPaths,
  )));
  return {
    bundle: {
      session: projectSessionSummary(bundle.session),
      evidence: projected
        .map((value) => value.evidence)
        .filter((value): value is NonNullable<typeof value> => value !== null),
      unknownRecordCount: bundle.unknownRecordCount,
      diagnostics: bundle.diagnostics,
    },
    droppedIncompatibleChanges: projected.reduce((count, value) =>
      count + (value.droppedAsIncompatible ? value.droppedChangeCount : 0), 0),
  };
}

async function existingCanonicalPath(value: string): Promise<string | null> {
  if (!path.isAbsolute(value)) return null;
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

async function historicalCommonGitDir(
  runner: GitRunner,
  directory: string,
): Promise<string | null> {
  try {
    const result = await runner.run(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: directory },
    );
    if (result.exitCode !== 0) return null;
    const value = result.stdout.toString("utf8").trim();
    return value.length === 0 ? null : path.resolve(value);
  } catch {
    return null;
  }
}

async function historicalWorktreeRoot(
  runner: GitRunner,
  directory: string,
): Promise<string | null> {
  try {
    const result = await runner.run(
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      { cwd: directory },
    );
    if (result.exitCode !== 0) return null;
    const value = result.stdout.toString("utf8").trim();
    return value.length === 0 ? null : path.resolve(value);
  } catch {
    return null;
  }
}

function deletedMappedWorktree(
  repository: RepositoryContext,
  directory: string,
): { readonly repositoryMatch: CorrelationRepositoryMatch; readonly repositoryRoot: string } | null {
  if (!path.isAbsolute(directory)) return null;
  const normalizedDirectory = path.resolve(directory);
  const normalizedCurrentRoot = path.resolve(repository.worktreeRoot);
  const linked = repository.worktrees.find((worktree) => {
    const worktreeRoot = path.resolve(worktree.path);
    return worktreeRoot !== normalizedCurrentRoot
      && worktree.prunable
      && isWithinDirectory(worktreeRoot, normalizedDirectory);
  });
  return linked === undefined
    ? null
    : { repositoryMatch: "linked-worktree", repositoryRoot: path.resolve(linked.path) };
}

function positiveMatch(
  left: CorrelationRepositoryMatch,
  right: CorrelationRepositoryMatch,
): CorrelationRepositoryMatch {
  const rank = (value: CorrelationRepositoryMatch): number => {
    switch (value) {
      case "current-worktree": return 3;
      case "linked-worktree": return 2;
      case "same-common-directory": return 1;
      default: return 0;
    }
  };
  return rank(right) > rank(left) ? right : left;
}

async function resolveHistoricalDirectory(
  runner: GitRunner,
  repository: RepositoryContext,
  directory: string,
): Promise<HistoricalDirectoryResolution> {
  const canonical = await existingCanonicalPath(directory);
  if (canonical !== null) {
    const currentRoot = path.resolve(repository.worktreeRoot);
    if (canonical === currentRoot) {
      return {
        repositoryMatch: "current-worktree",
        pathMapping: { repositoryRoot: currentRoot, historicalCwd: canonical },
      };
    }

    const linked = repository.worktrees.find((worktree) =>
      path.resolve(worktree.path) !== currentRoot
        && path.resolve(worktree.path) === canonical);
    if (linked !== undefined) {
      return {
        repositoryMatch: "linked-worktree",
        pathMapping: {
          repositoryRoot: path.resolve(linked.path),
          historicalCwd: canonical,
        },
      };
    }

    const commonGitDir = await historicalCommonGitDir(runner, directory);
    if (commonGitDir === null) {
      return { repositoryMatch: "unknown", pathMapping: null };
    }
    if (path.resolve(commonGitDir) !== path.resolve(repository.commonGitDir)) {
      return { repositoryMatch: "incompatible", pathMapping: null };
    }

    if (isWithinDirectory(currentRoot, canonical)) {
      return {
        repositoryMatch: "current-worktree",
        pathMapping: { repositoryRoot: currentRoot, historicalCwd: canonical },
      };
    }

    const linkedInside = repository.worktrees.find((worktree) =>
      path.resolve(worktree.path) !== currentRoot
        && isWithinDirectory(path.resolve(worktree.path), canonical));
    if (linkedInside !== undefined) {
      return {
        repositoryMatch: "linked-worktree",
        pathMapping: {
          repositoryRoot: path.resolve(linkedInside.path),
          historicalCwd: canonical,
        },
      };
    }

    const historicalRoot = await historicalWorktreeRoot(runner, directory);
    return {
      repositoryMatch: "same-common-directory",
      pathMapping: historicalRoot === null
        ? null
        : { repositoryRoot: historicalRoot, historicalCwd: canonical },
    };
  }

  const mapped = deletedMappedWorktree(repository, directory);
  if (mapped !== null) {
    return {
      repositoryMatch: mapped.repositoryMatch,
      pathMapping: {
        repositoryRoot: mapped.repositoryRoot,
        historicalCwd: path.resolve(directory),
      },
    };
  }

  return { repositoryMatch: "unknown", pathMapping: null };
}

async function classifyRepository(
  runner: GitRunner,
  repository: RepositoryContext,
  summary: AgentSessionSummary,
): Promise<RepositoryAssessment> {
  const directories = [...new Set([
    summary.initialCwd,
    ...summary.workingDirectories,
  ].filter((value): value is string => value !== undefined))];
  let foundUnresolved = false;
  let foundIncompatible = false;
  let match: CorrelationRepositoryMatch = "unknown";
  let pathMapping: HistoricalPathMapping | null = null;
  let initialResolution: HistoricalDirectoryResolution = {
    repositoryMatch: "unknown",
    pathMapping: null,
  };

  for (const directory of directories) {
    const resolved = await resolveHistoricalDirectory(runner, repository, directory);
    if (directory === summary.initialCwd) {
      initialResolution = resolved;
    }
    if (directory === summary.initialCwd && resolved.pathMapping !== null) {
      pathMapping = resolved.pathMapping;
    }
    if (resolved.repositoryMatch === "incompatible") {
      foundIncompatible = true;
      continue;
    }
    if (resolved.repositoryMatch === "unknown") {
      foundUnresolved = true;
      continue;
    }
    match = positiveMatch(match, resolved.repositoryMatch);
  }

  return {
    repositoryMatch: match !== "unknown"
      ? match
      : foundUnresolved
        ? "unknown"
        : foundIncompatible
          ? "incompatible"
          : "unknown",
    pathMapping,
    initialResolution,
    cwdlessResolution: foundIncompatible || foundUnresolved || directories.length === 0
      ? null
      : initialResolution,
  };
}

function referenceRank(references: readonly ResolvedCommitReference[]): number {
  return references.some((reference) =>
    reference.resolution === "target"
      && (reference.kind === "session-head" || reference.kind === "produced-commit"))
    ? 1
    : 0;
}

function repositoryRank(match: CorrelationRepositoryMatch): number {
  switch (match) {
    case "current-worktree": return 2;
    case "linked-worktree":
    case "same-common-directory": return 1;
    default: return 0;
  }
}

function temporalRank(target: CorrelationTarget, summary: AgentSessionSummary): number {
  const sessionTimes = [summary.startedAt, summary.observedThroughAt]
    .filter((value): value is string => value !== undefined)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  const commitTimes = [target.commit.authoredAt, target.commit.committedAt]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (sessionTimes.length === 0 || commitTimes.length === 0) return 0;

  const start = Math.min(...sessionTimes);
  const end = Math.max(...sessionTimes);
  const distance = Math.min(...commitTimes.map((time) =>
    time < start ? start - time : time > end ? time - end : 0));
  if (distance <= 24 * 60 * 60 * 1000) return 2;
  if (distance <= 7 * 24 * 60 * 60 * 1000) return 1;
  return 0;
}

function compareStagedCandidates(
  left: SummaryCandidate,
  right: SummaryCandidate,
  target: CorrelationTarget,
): number {
  const leftRank = [
    referenceRank(left.references),
    repositoryRank(left.repositoryMatch),
    temporalRank(target, left.summary),
  ];
  const rightRank = [
    referenceRank(right.references),
    repositoryRank(right.repositoryMatch),
    temporalRank(target, right.summary),
  ];
  for (let index = 0; index < leftRank.length; index += 1) {
    const leftValue = leftRank[index] ?? 0;
    const rightValue = rightRank[index] ?? 0;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return left.ref.sourcePath.localeCompare(right.ref.sourcePath);
}

function extractionTarget(
  target: CorrelationTarget,
  location: ResolvedCodeLocation,
): AgentEvidenceTarget {
  return {
    repositoryPath: target.targetPath,
    line: location.requestedLine,
    worktreeRoot: target.repository.worktreeRoot,
  };
}

async function discover(
  source: AgentHistorySource,
  context: AgentHistoryDiscoveryContext | undefined,
): Promise<AgentHistoryDiscoveryResult> {
  if (source.discoverWithDiagnostics !== undefined) {
    try {
      return await source.discoverWithDiagnostics(context);
    } catch {
      return {
        availability: "unavailable",
        refs: [],
        diagnostics: [{ kind: "unreadable-transcript" }],
      };
    }
  }

  const refs: AgentSessionRef[] = [];
  try {
    for await (const ref of source.discover(context)) refs.push(ref);
  } catch {
    return {
      availability: "unavailable",
      refs,
      diagnostics: [{ kind: "unreadable-transcript" }],
    };
  }
  return {
    availability: "limited",
    refs,
    diagnostics: [{ kind: "unsupported-source", detail: "discovery coverage unavailable" }],
  };
}

function scanBundle(scan: AgentSummaryRelevanceScan): AgentEvidenceBundle {
  return {
    session: scan.summary,
    evidence: scan.correlationEvidence.evidence,
    unknownRecordCount: scan.correlationEvidence.unknownRecordCount,
    diagnostics: scan.summary.diagnostics,
  };
}

function fallbackScan(ref: AgentSessionRef): AgentSummaryRelevanceScan {
  const summary = fallbackSummary(ref, "unreadable-transcript");
  return {
    ref,
    summary,
    correlationEvidence: { evidence: [], unknownRecordCount: 0 },
    relevanceCoverage: { status: "limited", reasons: ["unreadable-transcript"] },
    bytesRead: 0,
    recordsSeen: 0,
    sourceSignature: null,
  };
}

function scanLimitations(scan: AgentSummaryRelevanceScan): readonly CorrelationLimitation[] {
  const result: CorrelationLimitation[] = [];
  for (const reason of scan.relevanceCoverage.reasons) {
    switch (reason) {
      case "changed-during-read":
        result.push(limitation("changed-during-read", true));
        break;
      case "partial-record":
      case "corrupt-record":
      case "unreadable-transcript":
        result.push(limitation("corrupt-transcript", true));
        break;
      case "material-compaction":
      case "material-rollback-or-abort":
        break;
      case "retention-limit":
      case "unsupported-relevance-record":
      case "unlinked-patch-result":
      case "invalid-durable-patch-terminal":
      case "unclassified-patch-change":
      case "missing-effective-cwd":
        result.push(limitation("summary-coverage", true));
        break;
      default:
        break;
    }
  }
  return result;
}

function discoveryNamespaceChanged(
  opening: AgentHistoryDiscoveryResult,
  closing: AgentHistoryDiscoveryResult,
): boolean {
  if (opening.namespaceSignature !== undefined || closing.namespaceSignature !== undefined) {
    return opening.namespaceSignature !== closing.namespaceSignature;
  }
  if (opening.availability !== closing.availability) return true;
  const key = (ref: AgentSessionRef): string => ref.sourceKind + "\0" + ref.sourcePath;
  const openingRefs = opening.refs.map(key).sort();
  const closingRefs = closing.refs.map(key).sort();
  return openingRefs.length !== closingRefs.length
    || openingRefs.some((value, index) => value !== closingRefs[index]);
}

function hasPatchEvidence(scan: AgentSummaryRelevanceScan): boolean {
  return scan.correlationEvidence.evidence.some((value) =>
    value.kind === "patch-attempt" || value.kind === "patch-result");
}

function scanPathClassificationIsComplete(
  scan: AgentSummaryRelevanceScan,
  summary: AgentSessionSummary,
  repositoryMatch: CorrelationRepositoryMatch,
  pathMapping: HistoricalPathMapping | null,
): boolean {
  if (repositoryMatch === "unknown" || repositoryMatch === "incompatible") return false;
  const patchEvidence = scan.correlationEvidence.evidence.filter((value) =>
    value.kind === "patch-result" && value.reportedSuccess === true);
  if (patchEvidence.length === 0) return true;
  if (summary.workingDirectories.length > 1 || summary.initialCwd === undefined) return false;
  if (pathMapping === null
    || path.resolve(pathMapping.historicalCwd) !== path.resolve(pathMapping.repositoryRoot)) {
    return false;
  }
  return patchEvidence.every((value) => value.cwd === summary.initialCwd);
}

interface ProjectionOutcome {
  readonly input: CorrelationCandidateInput;
  readonly projected: boolean;
  readonly possibility: CandidateStrongPossibility;
}

async function correlateCodexHardened(
  options: CorrelateCodexOptions,
): Promise<CorrelationResult> {
  const totalStartedAt = performance.now();
  const discoveryContext: AgentHistoryDiscoveryContext | undefined = options.codexHome === undefined
    ? undefined
    : { historyRoot: options.codexHome };
  const source = options.agentHistorySource
    ?? new CodexHistorySource(options.codexHome === undefined ? {} : { codexHome: options.codexHome });
  const discovery = await discover(source, discoveryContext);
  const coverageLimitations = [...discoveryDiagnosticLimitations(discovery.diagnostics)];

  if (discovery.availability === "unavailable") {
    const result = correlate(options.target, [], {
      status: "unavailable",
      discoveredRefs: discovery.refs.length,
      usableSummaryRefs: 0,
      incompatibleRefs: 0,
      provenNotStrongRefs: 0,
      potentiallyStrongRefs: 0,
      fullyProjectedRefs: 0,
      omittedPotentiallyStrongRefs: 0,
      limitations: [limitation("discovery-unavailable", true), ...coverageLimitations],
    });
    recordEmptyCorrelationTelemetry(
      options.telemetry,
      discovery.refs.length,
      performance.now() - totalStartedAt,
      result,
    );
    return result;
  }
  if (discovery.refs.length === 0 && discovery.availability === "available") {
    coverageLimitations.push(limitation("empty-readable-store", false));
  }
  if (discovery.availability === "limited") {
    coverageLimitations.push(limitation("discovery-limited", true));
  }

  const defaults = defaultCorrelationWorkLimits(discovery.refs.length);
  const defaultScanWorkers = Math.max(1, defaults.scanWorkers);
  const defaultGitProcessSlots = Math.max(1, defaults.gitProcessSlots);
  const defaultProjectionWorkers = Math.max(1, defaults.projectionWorkers);
  const limits: CorrelationWorkLimits = {
    scanWorkers: options.workLimits?.scanWorkers ?? defaultScanWorkers,
    gitProcessSlots: options.workLimits?.gitProcessSlots ?? defaultGitProcessSlots,
    projectionWorkers: options.workLimits?.projectionWorkers ?? defaultProjectionWorkers,
  };
  const targetHint = extractionTarget(options.target, options.location);
  const scanPool = new BoundedWorkPool(limits.scanWorkers);
  const scanned = await scanPool.map(discovery.refs, async (ref) => {
    try {
      return await source.scanSummaryAndRelevance(ref, targetHint);
    } catch {
      return fallbackScan(ref);
    }
  });

  const closingDiscovery = await discover(source, discoveryContext);
  if (discoveryNamespaceChanged(discovery, closingDiscovery)) {
    coverageLimitations.push(limitation("changed-during-read", true));
  }

  const gate = new GitWorkGate(limits.gitProcessSlots);
  const git = new InvocationGitRunner(options.git, gate);
  const classifiedPool = new BoundedWorkPool(limits.gitProcessSlots);
  const staged = await classifiedPool.map(scanned, async (scan): Promise<SummaryCandidate> => {
    const summary = scan.summary;
    const assessment = await classifyRepository(git, options.repository, summary);
    const references = await resolveReferences(
      git,
      options.repository,
      options.target,
      summaryReferences(summary),
    );
    const possibility = classifyStrongPossibility({
      repositoryMatch: assessment.repositoryMatch,
      correlationEvidence: {
        evidence: scan.correlationEvidence.evidence,
        unknownRecordCount: scan.correlationEvidence.unknownRecordCount,
      },
      relevanceCoverage: scan.relevanceCoverage,
      targetAliases: targetPathAliases(options.target),
      pathClassificationComplete: scanPathClassificationIsComplete(
        scan,
        summary,
        assessment.repositoryMatch,
        assessment.pathMapping,
      ),
    });
    const candidateLimitations = [
      ...diagnosticLimitations(summary.diagnostics),
      ...scanLimitations(scan),
    ];
    const request: CandidateBuildRequest = {
      session: projectSessionSummary(summary),
      evidence: null,
      repositoryMatch: possibility.state === "excluded" ? "incompatible" : assessment.repositoryMatch,
      references,
      coverageLimitations: candidateLimitations,
    };
    return {
      ref: scan.ref,
      scan,
      summary,
      repositoryMatch: assessment.repositoryMatch,
      pathMapping: assessment.pathMapping,
      cwdlessResolution: assessment.cwdlessResolution,
      references,
      input: buildCandidateInput(request),
      possibility,
    };
  });

  const ordered = [...staged].sort((left, right) => compareStagedCandidates(left, right, options.target));
  const potentiallyStrong = ordered.filter((candidate) =>
    candidate.input.eligible && candidate.possibility.state === "cannot-prove");
  const selectedForProjection = potentiallyStrong.slice(0, MAX_FULL_EVIDENCE_CANDIDATES);
  const inputs = new Map<string, CorrelationCandidateInput>(
    staged.map((candidate) => [candidate.ref.sourcePath, candidate.input]),
  );
  let fullyProjectedRefs = 0;
  let projectionStats: BoundedWorkStats = {
    wallMs: 0,
    queueMsSum: 0,
    queueMsMax: 0,
    workMsSum: 0,
  };
  let projectionOutcomes: ProjectionOutcome[] = [];
  if (selectedForProjection.length > 0) {
    const projectionPool = new BoundedWorkPool(limits.projectionWorkers);
    projectionOutcomes = await projectionPool.map(selectedForProjection, async (candidate): Promise<ProjectionOutcome> => {
      const rawBundle = scanBundle(candidate.scan);
      if (!hasPatchEvidence(candidate.scan)) {
        return {
          projected: true,
          possibility: candidate.possibility,
          input: buildCandidateInput({
            session: projectSessionSummary(candidate.summary),
            evidence: rawBundle,
            repositoryMatch: candidate.repositoryMatch,
            references: candidate.references,
            coverageLimitations: candidate.input.coverageLimitations,
          }),
        };
      }

      const historicalAnchorPaths = candidate.repositoryMatch === "unknown"
        && hasResolvedTargetAnchor(candidate.references)
        ? targetPathAliases(options.target)
        : null;
      let projectedBundle: AgentEvidenceBundle | null = null;
      let projectionLimitations: readonly CorrelationLimitation[] = [];
      let projectionComplete = false;
      try {
        const projectedResult = await projectEvidenceBundle(
          rawBundle,
          options.repository,
          git,
          candidate.cwdlessResolution,
          historicalAnchorPaths,
        );
        const originalChanges = rawBundle.evidence
          .filter((value) => value.kind === "patch-result")
          .flatMap((value) => value.patch?.changes ?? []);
        const projectedChanges = projectedResult.bundle.evidence
          .filter((value) => value.kind === "patch-result")
          .flatMap((value) => value.patch?.changes ?? []);
        const allChangesKnownIncompatible = originalChanges.length > 0
          && projectedChanges.length === 0
          && projectedResult.droppedIncompatibleChanges === originalChanges.length;
        projectionComplete = !allChangesKnownIncompatible
          && projectedChanges.length + projectedResult.droppedIncompatibleChanges
            === originalChanges.length;
        projectedBundle = projectedResult.bundle;
        if (!projectionComplete && !allChangesKnownIncompatible) {
          projectionLimitations = [limitation("summary-coverage", true)];
        }
      } catch {
        projectionLimitations = [limitation("corrupt-transcript", true)];
      }
      if (projectedBundle === null) {
        return {
          projected: false,
          possibility: candidate.possibility,
          input: buildCandidateInput({
            session: projectSessionSummary(candidate.summary),
            evidence: null,
            repositoryMatch: candidate.repositoryMatch,
            references: candidate.references,
            coverageLimitations: [...candidate.input.coverageLimitations, ...projectionLimitations],
          }),
        };
      }
      const possibility = classifyStrongPossibility({
        repositoryMatch: candidate.repositoryMatch,
        correlationEvidence: {
          evidence: projectedBundle.evidence,
          unknownRecordCount: candidate.scan.correlationEvidence.unknownRecordCount,
        },
        relevanceCoverage: candidate.scan.relevanceCoverage,
        targetAliases: targetPathAliases(options.target),
        pathClassificationComplete: projectionComplete,
      });
      return {
        projected: true,
        possibility,
        input: buildCandidateInput({
          session: projectSessionSummary(candidate.summary),
          evidence: projectedBundle,
          repositoryMatch: candidate.repositoryMatch,
          references: candidate.references,
          coverageLimitations: [...candidate.input.coverageLimitations, ...projectionLimitations],
        }),
      };
    });
    fullyProjectedRefs = projectionOutcomes.filter((value) => value.projected).length;
    projectionOutcomes.forEach((value, ordinal) => {
      const candidate = selectedForProjection[ordinal];
      if (candidate !== undefined) inputs.set(candidate.ref.sourcePath, value.input);
    });
    projectionStats = projectionPool.stats;
  }

  const projectedPossibilities = new Map<string, CandidateStrongPossibility>(
    staged.map((candidate) => [candidate.ref.sourcePath, candidate.possibility]),
  );
  projectionOutcomes.forEach((value, ordinal) => {
    const candidate = selectedForProjection[ordinal];
    if (candidate !== undefined) projectedPossibilities.set(candidate.ref.sourcePath, value.possibility);
  });

  const finalLimitations = [...coverageLimitations];
  const unsupportedSummaryCount = staged.filter((candidate) =>
    candidate.input.coverageLimitations.some((value) => value.kind === "unsupported-summary")).length;
  const unresolvedCount = staged.filter((candidate) =>
    candidate.input.coverageLimitations.some((value) => value.kind === "unresolved-repository-candidate")).length;
  if (unsupportedSummaryCount > 0) {
    finalLimitations.push(limitation("unsupported-summary", true, unsupportedSummaryCount));
  }
  if (unresolvedCount > 0) {
    finalLimitations.push(limitation("unresolved-repository-candidate", true, unresolvedCount));
  }
  const omittedPotentiallyStrongRefs = Math.max(potentiallyStrong.length - selectedForProjection.length, 0);
  if (omittedPotentiallyStrongRefs > 0) {
    finalLimitations.push(limitation("candidate-cap", true, omittedPotentiallyStrongRefs));
  }
  const provenNotStrongRefs = staged.filter((candidate) =>
    projectedPossibilities.get(candidate.ref.sourcePath)?.state === "proven-not-strong").length;
  const incompatibleRefs = staged.filter((candidate) =>
    projectedPossibilities.get(candidate.ref.sourcePath)?.state === "excluded").length;
  const potentiallyStrongRefs = staged.filter((candidate) =>
    candidate.input.eligible
      && projectedPossibilities.get(candidate.ref.sourcePath)?.state === "cannot-prove").length;
  const usableSummaryRefs = staged.filter((candidate) => candidate.summary.sessionId !== null).length;
  const status = discovery.availability === "limited" || finalLimitations.some((value) => value.material)
    ? "limited" as const
    : "complete" as const;
  const result = correlate(options.target, [...inputs.values()], {
    status,
    discoveredRefs: discovery.refs.length,
    usableSummaryRefs,
    incompatibleRefs,
    provenNotStrongRefs,
    potentiallyStrongRefs,
    fullyProjectedRefs,
    omittedPotentiallyStrongRefs,
    limitations: finalLimitations,
  });
  recordCorrelationTelemetry(options.telemetry, result, staged, {
    discoveredRefs: discovery.refs.length,
    bytesScanned: scanned.reduce((total, value) => total + value.bytesRead, 0),
    scan: scanPool.stats,
    git: gate.stats,
    gitCalls: git.calls,
    projection: projectionStats,
    projectedCandidates: selectedForProjection.length,
    totalMs: performance.now() - totalStartedAt,
  });
  return result;
}

export async function correlateCodex(
  options: CorrelateCodexOptions,
): Promise<CorrelationResult> {
  return correlateCodexHardened(options);
}

function preparedWorkLimits(
  discovery: AgentHistoryDiscoveryResult,
  requested?: Partial<CorrelationWorkLimits>,
): CorrelationWorkLimits {
  const defaults = defaultCorrelationWorkLimits(discovery.refs.length);
  return {
    scanWorkers: requested?.scanWorkers ?? Math.max(1, defaults.scanWorkers),
    gitProcessSlots: requested?.gitProcessSlots ?? Math.max(1, defaults.gitProcessSlots),
    projectionWorkers: requested?.projectionWorkers ?? Math.max(1, defaults.projectionWorkers),
  };
}

export async function prepareCodexEvidence(
  options: PrepareCodexEvidenceOptions,
): Promise<PreparedCodexEvidence> {
  const discoveryContext: AgentHistoryDiscoveryContext | undefined = options.codexHome === undefined
    ? undefined
    : { historyRoot: options.codexHome };
  const source = options.agentHistorySource
    ?? new CodexHistorySource(options.codexHome === undefined ? {} : { codexHome: options.codexHome });
  const discovery = await discover(source, discoveryContext);
  const limits = preparedWorkLimits(discovery, options.workLimits);
  const gate = new GitWorkGate(limits.gitProcessSlots);
  const git = new InvocationGitRunner(options.git, gate);
  const coverageLimitations = [...discoveryDiagnosticLimitations(discovery.diagnostics)];

  if (discovery.availability === "unavailable") {
    return {
      source,
      repository: options.repository,
      discovery,
      candidates: [],
      coverageLimitations: [
        limitation("discovery-unavailable", true),
        ...coverageLimitations,
      ],
      git,
      limits,
    };
  }
  if (discovery.refs.length === 0 && discovery.availability === "available") {
    coverageLimitations.push(limitation("empty-readable-store", false));
  }
  if (discovery.availability === "limited") {
    coverageLimitations.push(limitation("discovery-limited", true));
  }

  const scanPool = new BoundedWorkPool(limits.scanWorkers);
  const scanned = await scanPool.map(discovery.refs, async (ref) => {
    try {
      return await source.scanSummaryAndRelevance(ref);
    } catch {
      return fallbackScan(ref);
    }
  });

  const closingDiscovery = await discover(source, discoveryContext);
  if (discoveryNamespaceChanged(discovery, closingDiscovery)) {
    coverageLimitations.push(limitation("changed-during-read", true));
  }

  const classifiedPool = new BoundedWorkPool(limits.gitProcessSlots);
  const candidates = await classifiedPool.map(scanned, async (scan): Promise<PreparedCodexCandidate> => {
    const summary = scan.summary;
    const assessment = await classifyRepository(git, options.repository, summary);
    return {
      ref: scan.ref,
      scan,
      summary,
      repositoryMatch: assessment.repositoryMatch,
      pathMapping: assessment.pathMapping,
      cwdlessResolution: assessment.cwdlessResolution,
      coverageLimitations: [
        ...diagnosticLimitations(summary.diagnostics),
        ...scanLimitations(scan),
      ],
      pathClassificationComplete: scanPathClassificationIsComplete(
        scan,
        summary,
        assessment.repositoryMatch,
        assessment.pathMapping,
      ),
    };
  });

  return {
    source,
    repository: options.repository,
    discovery,
    candidates,
    coverageLimitations,
    git,
    limits,
  };
}

async function projectPreparedCommitCodex(
  prepared: PreparedCodexEvidence,
  target: CorrelationTarget,
  _location: ResolvedCodeLocation,
): Promise<CorrelationResult> {
  if (prepared.discovery.availability === "unavailable") {
    return correlate(target, [], {
      status: "unavailable",
      discoveredRefs: prepared.discovery.refs.length,
      usableSummaryRefs: 0,
      incompatibleRefs: 0,
      provenNotStrongRefs: 0,
      potentiallyStrongRefs: 0,
      fullyProjectedRefs: 0,
      omittedPotentiallyStrongRefs: 0,
      limitations: prepared.coverageLimitations,
    });
  }

  const staged = await Promise.all(prepared.candidates.map(async (candidate): Promise<SummaryCandidate> => {
    const references = await resolveReferences(
      prepared.git,
      prepared.repository,
      target,
      summaryReferences(candidate.summary),
    );
    const possibility = classifyStrongPossibility({
      repositoryMatch: candidate.repositoryMatch,
      correlationEvidence: {
        evidence: candidate.scan.correlationEvidence.evidence,
        unknownRecordCount: candidate.scan.correlationEvidence.unknownRecordCount,
      },
      relevanceCoverage: candidate.scan.relevanceCoverage,
      targetAliases: targetPathAliases(target),
      pathClassificationComplete: candidate.pathClassificationComplete,
    });
    return {
      ref: candidate.ref,
      scan: candidate.scan,
      summary: candidate.summary,
      repositoryMatch: candidate.repositoryMatch,
      pathMapping: candidate.pathMapping,
      cwdlessResolution: candidate.cwdlessResolution,
      references,
      input: buildCandidateInput({
        session: projectSessionSummary(candidate.summary),
        evidence: null,
        repositoryMatch: possibility.state === "excluded" ? "incompatible" : candidate.repositoryMatch,
        references,
        coverageLimitations: candidate.coverageLimitations,
      }),
      possibility,
    };
  }));

  const ordered = [...staged].sort((left, right) => compareStagedCandidates(left, right, target));
  const potentiallyStrong = ordered.filter((candidate) =>
    candidate.input.eligible && candidate.possibility.state === "cannot-prove");
  const selectedForProjection = potentiallyStrong.slice(0, MAX_FULL_EVIDENCE_CANDIDATES);
  const inputs = new Map<string, CorrelationCandidateInput>(
    staged.map((candidate) => [candidate.ref.sourcePath, candidate.input]),
  );
  const projectionPool = new BoundedWorkPool(prepared.limits.projectionWorkers);
  const projectionOutcomes = await projectionPool.map(
    selectedForProjection,
    async (candidate): Promise<ProjectionOutcome> => {
      const rawBundle = scanBundle(candidate.scan);
      if (!hasPatchEvidence(candidate.scan)) {
        return {
          projected: true,
          possibility: candidate.possibility,
          input: buildCandidateInput({
            session: projectSessionSummary(candidate.summary),
            evidence: rawBundle,
            repositoryMatch: candidate.repositoryMatch,
            references: candidate.references,
            coverageLimitations: candidate.input.coverageLimitations,
          }),
        };
      }

      const historicalAnchorPaths = candidate.repositoryMatch === "unknown"
        && hasResolvedTargetAnchor(candidate.references)
        ? targetPathAliases(target)
        : null;
      let projectedBundle: AgentEvidenceBundle | null = null;
      let projectionLimitations: readonly CorrelationLimitation[] = [];
      let projectionComplete = false;
      try {
        const projectedResult = await projectEvidenceBundle(
          rawBundle,
          prepared.repository,
          prepared.git,
          candidate.cwdlessResolution,
          historicalAnchorPaths,
        );
        const originalChanges = rawBundle.evidence
          .filter((value) => value.kind === "patch-result")
          .flatMap((value) => value.patch?.changes ?? []);
        const projectedChanges = projectedResult.bundle.evidence
          .filter((value) => value.kind === "patch-result")
          .flatMap((value) => value.patch?.changes ?? []);
        const allChangesKnownIncompatible = originalChanges.length > 0
          && projectedChanges.length === 0
          && projectedResult.droppedIncompatibleChanges === originalChanges.length;
        projectionComplete = !allChangesKnownIncompatible
          && projectedChanges.length + projectedResult.droppedIncompatibleChanges
            === originalChanges.length;
        projectedBundle = projectedResult.bundle;
        if (!projectionComplete && !allChangesKnownIncompatible) {
          projectionLimitations = [limitation("summary-coverage", true)];
        }
      } catch {
        projectionLimitations = [limitation("corrupt-transcript", true)];
      }
      if (projectedBundle === null) {
        return {
          projected: false,
          possibility: candidate.possibility,
          input: buildCandidateInput({
            session: projectSessionSummary(candidate.summary),
            evidence: null,
            repositoryMatch: candidate.repositoryMatch,
            references: candidate.references,
            coverageLimitations: [...candidate.input.coverageLimitations, ...projectionLimitations],
          }),
        };
      }
      const possibility = classifyStrongPossibility({
        repositoryMatch: candidate.repositoryMatch,
        correlationEvidence: {
          evidence: projectedBundle.evidence,
          unknownRecordCount: candidate.scan.correlationEvidence.unknownRecordCount,
        },
        relevanceCoverage: candidate.scan.relevanceCoverage,
        targetAliases: targetPathAliases(target),
        pathClassificationComplete: projectionComplete,
      });
      return {
        projected: true,
        possibility,
        input: buildCandidateInput({
          session: projectSessionSummary(candidate.summary),
          evidence: projectedBundle,
          repositoryMatch: candidate.repositoryMatch,
          references: candidate.references,
          coverageLimitations: [...candidate.input.coverageLimitations, ...projectionLimitations],
        }),
      };
    },
  );

  const projectedPossibilities = new Map<string, CandidateStrongPossibility>(
    staged.map((candidate) => [candidate.ref.sourcePath, candidate.possibility]),
  );
  projectionOutcomes.forEach((value, ordinal) => {
    const candidate = selectedForProjection[ordinal];
    if (candidate !== undefined) {
      inputs.set(candidate.ref.sourcePath, value.input);
      projectedPossibilities.set(candidate.ref.sourcePath, value.possibility);
    }
  });

  const finalLimitations = [...prepared.coverageLimitations];
  const unsupportedSummaryCount = staged.filter((candidate) =>
    candidate.input.coverageLimitations.some((value) => value.kind === "unsupported-summary")).length;
  const unresolvedCount = staged.filter((candidate) =>
    candidate.input.coverageLimitations.some((value) => value.kind === "unresolved-repository-candidate")).length;
  if (unsupportedSummaryCount > 0) {
    finalLimitations.push(limitation("unsupported-summary", true, unsupportedSummaryCount));
  }
  if (unresolvedCount > 0) {
    finalLimitations.push(limitation("unresolved-repository-candidate", true, unresolvedCount));
  }
  const omittedPotentiallyStrongRefs = Math.max(
    potentiallyStrong.length - selectedForProjection.length,
    0,
  );
  if (omittedPotentiallyStrongRefs > 0) {
    finalLimitations.push(limitation("candidate-cap", true, omittedPotentiallyStrongRefs));
  }
  const provenNotStrongRefs = staged.filter((candidate) =>
    projectedPossibilities.get(candidate.ref.sourcePath)?.state === "proven-not-strong").length;
  const incompatibleRefs = staged.filter((candidate) =>
    projectedPossibilities.get(candidate.ref.sourcePath)?.state === "excluded").length;
  const potentiallyStrongRefs = staged.filter((candidate) =>
    candidate.input.eligible
      && projectedPossibilities.get(candidate.ref.sourcePath)?.state === "cannot-prove").length;
  const usableSummaryRefs = staged.filter((candidate) => candidate.summary.sessionId !== null).length;
  const status = prepared.discovery.availability === "limited"
    || finalLimitations.some((value) => value.material)
    ? "limited" as const
    : "complete" as const;

  return correlate(target, [...inputs.values()], {
    status,
    discoveredRefs: prepared.discovery.refs.length,
    usableSummaryRefs,
    incompatibleRefs,
    provenNotStrongRefs,
    potentiallyStrongRefs,
    fullyProjectedRefs: projectionOutcomes.filter((value) => value.projected).length,
    omittedPotentiallyStrongRefs,
    limitations: finalLimitations,
  });
}

interface ResolvedWorktreeIdentity {
  readonly kind: AgentWorktreeIdentity;
  readonly directory: string;
}

async function canonicalComparisonPath(value: string): Promise<string> {
  const canonical = await existingCanonicalPath(value);
  return canonical ?? path.resolve(value);
}

async function gitIdentityAt(
  runner: GitRunner,
  directory: string,
): Promise<{
  readonly root: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly objectFormat: string;
} | null> {
  const commands = await Promise.all([
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ["rev-parse", "--show-object-format"],
  ].map(async (args) => {
    try {
      return await runner.run(args, { cwd: directory });
    } catch {
      return null;
    }
  }));
  if (commands.some((result) => result === null || result.exitCode !== 0)) return null;
  const values = commands.map((result) => result?.stdout.toString("utf8").trim() ?? "");
  if (values.some((value) => value.length === 0)) return null;
  return {
    root: await canonicalComparisonPath(values[0] as string),
    gitDir: await canonicalComparisonPath(values[1] as string),
    commonGitDir: await canonicalComparisonPath(values[2] as string),
    objectFormat: values[3] as string,
  };
}

async function classifyWorktreeDirectory(
  runner: GitRunner,
  target: WorktreeCorrelationTarget,
  directory: string,
): Promise<ResolvedWorktreeIdentity> {
  let canonicalDirectory: string;
  try {
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) return { kind: "unknown", directory };
    canonicalDirectory = await canonicalComparisonPath(directory);
  } catch {
    return { kind: "unknown", directory };
  }
  const identity = await gitIdentityAt(runner, canonicalDirectory);
  if (identity === null) return { kind: "unknown", directory: canonicalDirectory };

  const targetRoot = await canonicalComparisonPath(target.repository.worktreeRoot);
  const targetGitDir = await canonicalComparisonPath(target.repository.gitDir);
  const targetCommonGitDir = await canonicalComparisonPath(target.repository.commonGitDir);
  const sameRoot = identity.root === targetRoot;
  const sameGitDir = identity.gitDir === targetGitDir;
  const sameCommonGitDir = identity.commonGitDir === targetCommonGitDir;
  const sameObjectFormat = identity.objectFormat === target.repository.objectFormat;
  if (sameRoot && sameGitDir && sameCommonGitDir && sameObjectFormat) {
    return { kind: "exact-current-worktree", directory: canonicalDirectory };
  }
  if (!sameCommonGitDir || !sameObjectFormat) {
    return { kind: "incompatible", directory: canonicalDirectory };
  }
  if (sameRoot) return { kind: "incompatible", directory: canonicalDirectory };
  const linked = target.repository.worktrees.some((worktree) =>
    path.resolve(worktree.path) === identity.root
      && path.resolve(worktree.path) !== path.resolve(target.repository.worktreeRoot));
  return {
    kind: linked ? "linked-worktree" : "same-common-directory",
    directory: canonicalDirectory,
  };
}

async function effectiveEvidenceDirectories(
  evidence: AgentEvidenceBundle["evidence"][number],
  summary: AgentSessionSummary,
): Promise<readonly string[]> {
  if (evidence.cwd !== undefined) {
    const directory = evidenceDirectory(evidence.cwd, summary.initialCwd);
    return directory === null ? [] : [directory];
  }
  return [...new Set([
    summary.initialCwd,
    ...summary.workingDirectories,
  ].filter((value): value is string => value !== undefined))]
    .map((value) => evidenceDirectory(value, summary.initialCwd))
    .filter((value): value is string => value !== null);
}

async function classifyWorktreeEvidence(
  runner: GitRunner,
  target: WorktreeCorrelationTarget,
  evidence: AgentEvidenceBundle["evidence"][number],
  summary: AgentSessionSummary,
): Promise<ResolvedWorktreeIdentity> {
  const directories = await effectiveEvidenceDirectories(evidence, summary);
  if (directories.length === 0) return { kind: "unknown", directory: "" };
  const identities = await Promise.all(directories.map((directory) =>
    classifyWorktreeDirectory(runner, target, directory)));
  const first = identities[0];
  if (first === undefined) return { kind: "unknown", directory: "" };
  if (evidence.cwd !== undefined || identities.every((value) => value.kind === first.kind)) {
    return first.kind === "exact-current-worktree"
      ? first
      : { kind: first.kind, directory: first.directory };
  }
  return { kind: "unknown", directory: first.directory };
}

function worktreePath(
  value: string,
  directory: string,
  target: WorktreeCorrelationTarget,
): string | null {
  if (value.length === 0 || value === "<outside-session-root>") return null;
  const absolute = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(directory, value);
  return relativeRepositoryPath(target.repository.worktreeRoot, absolute);
}

async function projectWorktreeEvidence(
  evidence: AgentEvidenceBundle["evidence"][number],
  summary: AgentSessionSummary,
  target: WorktreeCorrelationTarget,
  runner: GitRunner,
): Promise<AgentEvidenceBundle["evidence"][number]> {
  const identity = await classifyWorktreeEvidence(runner, target, evidence, summary);
  const directories = await effectiveEvidenceDirectories(evidence, summary);
  const directory = identity.directory || directories[0] || summary.initialCwd || target.repository.worktreeRoot;
  const projectChange = (change: NonNullable<typeof evidence.patch>["changes"][number]) => {
    const normalizedPath = worktreePath(change.path, directory, target);
    const normalizedMovedFrom = change.movedFrom === undefined
      ? undefined
      : worktreePath(change.movedFrom, directory, target);
    const next = normalizedPath === null ? change : { ...change, path: normalizedPath };
    return normalizedMovedFrom === undefined
      ? next
      : { ...next, movedFrom: normalizedMovedFrom ?? change.movedFrom };
  };
  const patch = evidence.patch === undefined
    ? undefined
    : {
      ...evidence.patch,
      changes: evidence.patch.changes.map(projectChange),
    };
  return {
    ...evidence,
    ...(identity.kind === undefined ? {} : { worktreeIdentity: identity.kind }),
    patch,
  };
}

function worktreeInput(
  candidate: PreparedCodexCandidate,
  evidence: AgentEvidenceBundle | null,
  extraLimitations: readonly CorrelationLimitation[] = [],
): CorrelationCandidateInput {
  return {
    session: projectSessionSummary(candidate.summary),
    evidence,
    repositoryMatch: candidate.repositoryMatch,
    eligible: candidate.summary.sessionId !== null && candidate.repositoryMatch !== "incompatible",
    references: [],
    coverageLimitations: [...candidate.coverageLimitations, ...extraLimitations],
  };
}

async function projectPreparedWorktreeCodex(
  prepared: PreparedCodexEvidence,
  target: WorktreeCorrelationTarget,
): Promise<CorrelationResult> {
  if (prepared.discovery.availability === "unavailable") {
    return correlateWorktree(target, [], {
      status: "unavailable",
      discoveredRefs: prepared.discovery.refs.length,
      usableSummaryRefs: 0,
      incompatibleRefs: 0,
      provenNotStrongRefs: 0,
      potentiallyStrongRefs: 0,
      fullyProjectedRefs: 0,
      omittedPotentiallyStrongRefs: 0,
      limitations: prepared.coverageLimitations,
    });
  }

  const staged = prepared.candidates.map((candidate) => ({
    candidate,
    input: worktreeInput(candidate, null),
  })).sort((left, right) => {
    const rank = (value: CorrelationRepositoryMatch): number => {
      switch (value) {
        case "current-worktree": return 3;
        case "linked-worktree": return 2;
        case "same-common-directory": return 1;
        default: return 0;
      }
    };
    const repositoryOrder = rank(right.candidate.repositoryMatch) - rank(left.candidate.repositoryMatch);
    if (repositoryOrder !== 0) return repositoryOrder;
    const pathOrder = left.candidate.ref.sourcePath.localeCompare(right.candidate.ref.sourcePath);
    return pathOrder !== 0
      ? pathOrder
      : (left.candidate.summary.sessionId ?? "").localeCompare(right.candidate.summary.sessionId ?? "");
  });
  const potentiallyStrong = staged.filter((value) =>
    value.input.eligible
      && (hasPatchEvidence(value.candidate.scan)
        || value.candidate.scan.relevanceCoverage.status !== "complete"));
  const selected = potentiallyStrong.slice(0, MAX_FULL_EVIDENCE_CANDIDATES);
  const omitted = Math.max(potentiallyStrong.length - selected.length, 0);
  const outcomes = await Promise.all(selected.map(async (value) => {
    const rawBundle = scanBundle(value.candidate.scan);
    try {
      const evidence = await Promise.all(rawBundle.evidence.map((item) =>
        projectWorktreeEvidence(item, rawBundle.session, target, prepared.git)));
      return {
        input: worktreeInput(value.candidate, {
          ...rawBundle,
          evidence,
        }),
        projected: true,
      };
    } catch {
      return {
        input: worktreeInput(value.candidate, null, [limitation("summary-coverage", true)]),
        projected: false,
      };
    }
  }));

  const inputs = staged.map((value) => value.input);
  selected.forEach((value, index) => {
    const outcome = outcomes[index];
    if (outcome !== undefined) {
      const stagedIndex = staged.indexOf(value);
      if (stagedIndex >= 0) inputs[stagedIndex] = outcome.input;
    }
  });
  await verifyPreparedCodexEvidenceStable(prepared);
  const stableVerifierAvailable = prepared.source.verifySourceSignature !== undefined;
  const retainedSignatureMissing = selected.some((value) => value.candidate.scan.sourceSignature === null);
  const stabilityLimitations = stableVerifierAvailable && !retainedSignatureMissing
    ? []
    : [limitation("summary-coverage", true)];
  const limitations = [...prepared.coverageLimitations, ...stabilityLimitations];
  if (omitted > 0) limitations.push(limitation("candidate-cap", true, omitted));
  const projectedCount = outcomes.filter((value) => value.projected).length;
  const usableSummaryRefs = prepared.candidates.filter((value) => value.summary.sessionId !== null).length;
  const candidateCoverage = outcomes.flatMap((value) => value.input.coverageLimitations);
  const status = prepared.discovery.availability === "limited"
    || [...limitations, ...candidateCoverage].some((value) => value.material)
    ? "limited" as const
    : "complete" as const;
  const result = correlateWorktree(target, inputs, {
    status,
    discoveredRefs: prepared.discovery.refs.length,
    usableSummaryRefs,
    incompatibleRefs: prepared.candidates.filter((value) => value.repositoryMatch === "incompatible").length,
    provenNotStrongRefs: Math.max(staged.length - potentiallyStrong.length, 0),
    potentiallyStrongRefs: potentiallyStrong.length,
    fullyProjectedRefs: projectedCount,
    omittedPotentiallyStrongRefs: omitted,
    limitations,
  });
  return result;
}

export async function verifyPreparedCodexEvidenceStable(
  prepared: PreparedCodexEvidence,
): Promise<void> {
  const closingDiscovery = await discover(prepared.source, undefined);
  if (discoveryNamespaceChanged(prepared.discovery, closingDiscovery)) {
    throw new OperationalError("agent history changed during worktree correlation");
  }
  const verifier = prepared.source.verifySourceSignature;
  if (verifier === undefined) return;
  for (const candidate of prepared.candidates) {
    const signature = candidate.scan.sourceSignature;
    if (signature === null) continue;
    const stable = await verifier.call(prepared.source, candidate.ref, signature);
    if (!stable) throw new OperationalError("agent history changed during worktree correlation");
  }
}

export async function projectPreparedCodex(
  prepared: PreparedCodexEvidence,
  target: ProvenanceCorrelationTarget,
  location: ResolvedCodeLocation,
): Promise<CorrelationResult> {
  return target.kind === "worktree"
    ? projectPreparedWorktreeCodex(prepared, target)
    : projectPreparedCommitCodex(prepared, target, location);
}
