import { realpath } from "node:fs/promises";
import path from "node:path";

import type {
  AgentCommitReferenceKind,
  AgentDiagnostic,
  AgentEvidenceBundle,
  AgentHistoryDiscoveryContext,
  AgentHistoryDiscoveryResult,
  AgentHistorySource,
  AgentSessionRef,
  AgentSessionSummary,
  AgentEvidenceTarget,
} from "../agents/agent-history-source.js";
import { codexHistorySource } from "../agents/codex/source.js";
import {
  buildCandidateInput,
  type CandidateBuildRequest,
} from "../correlation/build-candidates.js";
import { correlate } from "../correlation/correlate.js";
import type {
  CorrelationCandidateInput,
  CorrelationLimitation,
  CorrelationRepositoryMatch,
  CorrelationResult,
  CorrelationTarget,
  ResolvedCommitReference,
} from "../correlation/model.js";
import type { GitRunner } from "../git/git-process.js";
import { isWithinDirectory } from "../git/repository-context.js";
import type {
  RepositoryContext,
  ResolvedCodeLocation,
} from "./model.js";
import { resolveCommitReference } from "./resolve-commit-reference.js";

const MAX_FULL_EVIDENCE_CANDIDATES = 32;

interface RawReference {
  readonly kind: AgentCommitReferenceKind;
  readonly reference: string;
}

interface SummaryCandidate {
  readonly ref: AgentSessionRef;
  readonly summary: AgentSessionSummary;
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly pathMapping: HistoricalPathMapping | null;
  readonly references: readonly ResolvedCommitReference[];
  readonly input: CorrelationCandidateInput;
}

export interface CorrelateCodexOptions {
  readonly target: CorrelationTarget;
  readonly location: ResolvedCodeLocation;
  readonly repository: RepositoryContext;
  readonly git: GitRunner;
  readonly agentHistorySource?: AgentHistorySource;
  readonly codexHome?: string;
}

function limitation(
  kind: CorrelationLimitation["kind"],
  material: boolean,
  count?: number,
): CorrelationLimitation {
  return count === undefined ? { kind, material } : { kind, material, count };
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

function evidenceReferences(bundle: AgentEvidenceBundle): readonly RawReference[] {
  const references: RawReference[] = [];
  for (const evidence of bundle.evidence) {
    if (evidence.commitReferenceKind === undefined) continue;
    for (const commitId of evidence.commitIds) {
      references.push({ kind: evidence.commitReferenceKind, reference: commitId });
    }
  }
  return references;
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

function repositoryRoots(repository: RepositoryContext): readonly string[] {
  return [
    repository.worktreeRoot,
    ...repository.worktrees.map((worktree) => worktree.path),
  ]
    .map((root) => path.resolve(root))
    .filter((root, index, roots) => roots.indexOf(root) === index)
    .sort((left, right) => right.length - left.length);
}

function relativeRepositoryPath(root: string, value: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

function projectEvidencePath(
  value: string,
  repository: RepositoryContext,
  mapping: HistoricalPathMapping | null,
): string | null {
  if (value === "<outside-session-root>" || value.length === 0) return null;

  if (path.isAbsolute(value)) {
    for (const root of repositoryRoots(repository)) {
      const relative = relativeRepositoryPath(root, value);
      if (relative !== null) return relative;
    }
    return null;
  }

  if (mapping === null) return null;
  const historicalPath = path.resolve(mapping.historicalCwd, value);
  return relativeRepositoryPath(mapping.repositoryRoot, historicalPath);
}

function projectEvidence(
  evidence: AgentEvidenceBundle["evidence"][number],
  repository: RepositoryContext,
  mapping: HistoricalPathMapping | null,
): AgentEvidenceBundle["evidence"][number] {
  const patch = evidence.patch === undefined
    ? undefined
    : {
      ...evidence.patch,
      changes: evidence.patch.changes.flatMap((change) => {
        const normalizedPath = projectEvidencePath(change.path, repository, mapping);
        if (normalizedPath === null) return [];
        const normalizedMovedFrom = change.movedFrom === undefined
          ? null
          : projectEvidencePath(change.movedFrom, repository, mapping);
        const normalizedChange = { ...change, path: normalizedPath };
        if (normalizedMovedFrom === null) {
          delete normalizedChange.movedFrom;
          return [normalizedChange];
        }
        return [{ ...normalizedChange, movedFrom: normalizedMovedFrom }];
      }),
    };
  return {
    id: evidence.id,
    kind: evidence.kind,
    occurredAt: evidence.occurredAt,
    paths: evidence.paths.flatMap((value) => {
      const normalized = projectEvidencePath(value, repository, mapping);
      return normalized === null ? [] : [normalized];
    }),
    operation: evidence.operation,
    callId: evidence.callId,
    resultRecorded: evidence.resultRecorded,
    terminalSessionId: evidence.terminalSessionId,
    reportedSuccess: evidence.reportedSuccess,
    status: evidence.status,
    patch,
    commitReferenceKind: evidence.commitReferenceKind,
    commitIds: evidence.commitIds,
    extraction: evidence.extraction,
    sourceRecord: evidence.sourceRecord,
  };
}

function projectEvidenceBundle(
  bundle: AgentEvidenceBundle,
  repository: RepositoryContext,
  mapping: HistoricalPathMapping | null,
): AgentEvidenceBundle {
  return {
    session: projectSessionSummary(bundle.session),
    evidence: bundle.evidence.map((evidence) => projectEvidence(evidence, repository, mapping)),
    unknownRecordCount: bundle.unknownRecordCount,
    diagnostics: bundle.diagnostics,
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
    const commonGitDir = await historicalCommonGitDir(runner, directory);
    if (commonGitDir === null) {
      return { repositoryMatch: "unknown", pathMapping: null };
    }
    if (path.resolve(commonGitDir) !== path.resolve(repository.commonGitDir)) {
      return { repositoryMatch: "incompatible", pathMapping: null };
    }

    const currentRoot = path.resolve(repository.worktreeRoot);
    if (isWithinDirectory(currentRoot, canonical)) {
      return {
        repositoryMatch: "current-worktree",
        pathMapping: { repositoryRoot: currentRoot, historicalCwd: canonical },
      };
    }

    const linked = repository.worktrees.find((worktree) =>
      path.resolve(worktree.path) !== currentRoot
        && isWithinDirectory(path.resolve(worktree.path), canonical));
    if (linked !== undefined) {
      return {
        repositoryMatch: "linked-worktree",
        pathMapping: {
          repositoryRoot: path.resolve(linked.path),
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
  let foundIncompatible = false;
  let match: CorrelationRepositoryMatch = "unknown";
  let pathMapping: HistoricalPathMapping | null = null;

  for (const directory of directories) {
    const resolved = await resolveHistoricalDirectory(runner, repository, directory);
    if (directory === summary.initialCwd && resolved.pathMapping !== null) {
      pathMapping = resolved.pathMapping;
    }
    if (resolved.repositoryMatch === "incompatible") {
      foundIncompatible = true;
      continue;
    }
    match = positiveMatch(match, resolved.repositoryMatch);
  }

  return {
    repositoryMatch: foundIncompatible ? "incompatible" : match,
    pathMapping,
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

export async function correlateCodex(
  options: CorrelateCodexOptions,
): Promise<CorrelationResult> {
  const source = options.agentHistorySource ?? codexHistorySource;
  const discoveryContext = options.codexHome === undefined
    ? undefined
    : { historyRoot: options.codexHome };
  const discovery = await discover(source, discoveryContext);
  const coverageLimitations = [
    ...discoveryDiagnosticLimitations(discovery.diagnostics),
  ];

  if (discovery.availability === "unavailable") {
    return correlate(options.target, [], {
      status: "unavailable",
      discoveredRefs: discovery.refs.length,
      summaryEligibleRefs: 0,
      fullyExtractedRefs: 0,
      omittedEligibleRefs: 0,
      limitations: [
        limitation("discovery-unavailable", true),
        ...coverageLimitations,
      ],
    });
  }

  if (discovery.refs.length === 0 && discovery.availability === "available") {
    coverageLimitations.push(limitation("empty-readable-store", false));
  }
  if (discovery.availability === "limited") {
    coverageLimitations.push(limitation("discovery-limited", true));
  }

  const staged = await Promise.all(discovery.refs.map(async (ref): Promise<SummaryCandidate> => {
    let summary: AgentSessionSummary;
    try {
      summary = await source.readSummary(ref);
    } catch {
      summary = fallbackSummary(ref, "unreadable-transcript");
    }
    const assessment = await classifyRepository(options.git, options.repository, summary);
    const references = await resolveReferences(
      options.git,
      options.repository,
      options.target,
      summaryReferences(summary),
    );
    const request: CandidateBuildRequest = {
      session: projectSessionSummary(summary),
      evidence: null,
      repositoryMatch: assessment.repositoryMatch,
      references,
      coverageLimitations: diagnosticLimitations(summary.diagnostics),
    };
    return {
      ref,
      summary,
      repositoryMatch: assessment.repositoryMatch,
      pathMapping: assessment.pathMapping,
      references,
      input: buildCandidateInput(request),
    };
  }));

  const ordered = [...staged].sort((left, right) =>
    compareStagedCandidates(left, right, options.target));
  const eligible = ordered.filter((candidate) => candidate.input.eligible);
  const selectedForExtraction = eligible.slice(0, MAX_FULL_EVIDENCE_CANDIDATES);
  const inputs = new Map<string, CorrelationCandidateInput>(
    staged.map((candidate) => [candidate.ref.sourcePath, candidate.input]),
  );
  const targetHint = extractionTarget(options.target, options.location);
  let fullyExtractedRefs = 0;

  for (const candidate of selectedForExtraction) {
    let bundle: AgentEvidenceBundle | null = null;
    let extractionLimitations: readonly CorrelationLimitation[] = [];
    try {
      bundle = await source.extractEvidence(candidate.ref, targetHint);
      fullyExtractedRefs += 1;
    } catch {
      extractionLimitations = [limitation("corrupt-transcript", true)];
    }

    const fullReferences = bundle === null
      ? candidate.references
      : await resolveReferences(
        options.git,
        options.repository,
        options.target,
        [...summaryReferences(candidate.summary), ...evidenceReferences(bundle)],
      );
    const evidenceSession = bundle?.session ?? candidate.summary;
    const evidencePathMapping = evidenceSession.initialCwd === candidate.summary.initialCwd
      ? candidate.pathMapping
      : evidenceSession.initialCwd === undefined
        ? candidate.pathMapping
        : (await resolveHistoricalDirectory(
          options.git,
          options.repository,
          evidenceSession.initialCwd,
        )).pathMapping;
    const fullRequest: CandidateBuildRequest = {
      session: projectSessionSummary(evidenceSession),
      evidence: bundle === null
        ? null
        : projectEvidenceBundle(bundle, options.repository, evidencePathMapping),
      repositoryMatch: candidate.repositoryMatch,
      references: fullReferences,
      coverageLimitations: [
        ...candidate.input.coverageLimitations,
        ...extractionLimitations,
      ],
    };
    inputs.set(candidate.ref.sourcePath, buildCandidateInput(fullRequest));
  }

  const omittedEligibleRefs = Math.max(eligible.length - selectedForExtraction.length, 0);
  const finalLimitations = [...coverageLimitations];
  for (const kind of ["unsupported-summary", "unresolved-repository-candidate"] as const) {
    const count = staged.filter((candidate) =>
      candidate.input.coverageLimitations.some((value) => value.kind === kind)).length;
    if (count > 0) finalLimitations.push(limitation(kind, true, count));
  }
  if (omittedEligibleRefs > 0) {
    finalLimitations.push(limitation("candidate-cap", true, omittedEligibleRefs));
  }
  const finalCoverage = {
    status: discovery.availability === "limited" ? "limited" as const : "complete" as const,
    discoveredRefs: discovery.refs.length,
    summaryEligibleRefs: eligible.length,
    fullyExtractedRefs,
    omittedEligibleRefs,
    limitations: finalLimitations,
  };

  return correlate(options.target, [...inputs.values()], finalCoverage);
}
