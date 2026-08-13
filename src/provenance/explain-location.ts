import type { GitRunner } from "../git/git-process.js";
import { defaultGitProcess } from "../git/git-process.js";
import { blameLine } from "../git/blame-line.js";
import { discoverRepositoryContext } from "../git/repository-context.js";
import { inspectCommit } from "../git/inspect-commit.js";
import {
  resolveCurrentSource,
  resolvedCodeLocationFromSource,
} from "../location/resolve-location.js";
import { parseLocation } from "../location/parse-location.js";
import type { AgentHistorySource } from "../agents/agent-history-source.js";
import {
  correlateCodex,
  prepareCodexEvidence,
  projectPreparedCodex,
} from "./correlate-codex.js";
import { inspectWorktreeChange } from "../git/inspect-worktree-change.js";
import { verifyAnalysisStability } from "./verify-analysis-stability.js";
import type { CorrelationTelemetry } from "./correlation-telemetry.js";
import { buildCorrelationTarget } from "./build-correlation-target.js";
import { traceLineAncestry } from "../git/trace-line-ancestry.js";
import type {
  GitProvenance,
  WhylineReport,
} from "./model.js";
import type {
  CorrelationResult,
  WorktreeTargetConstruction,
} from "../correlation/model.js";

export interface AnalysisHooks {
  readonly beforeFinalVerification?: (report: WhylineReport) => void | Promise<void>;
}

export interface AnalyzeLocationOptions {
  readonly currentDirectory?: string;
  readonly git?: GitRunner;
  readonly hooks?: AnalysisHooks;
  readonly agentHistorySource?: AgentHistorySource;
  readonly codexHome?: string;
  readonly correlationTelemetry?: CorrelationTelemetry;
}

function baseLimitations(): string[] {
  return [
    "This is Git textual attribution: last textual attribution according to baseline Git blame.",
    "Refactors or code movement may hide the semantic origin.",
  ];
}

function worktreeCorrelationReport(
  location: WhylineReport["location"],
  inspection: Awaited<ReturnType<typeof inspectWorktreeChange>>,
  construction: WorktreeTargetConstruction,
  result?: CorrelationResult,
): WhylineReport["worktreeCorrelation"] {
  const target = construction.status === "ready" ? construction.target : undefined;
  const limitations = [
    ...(construction.status === "ready" ? [] : construction.limitations),
    ...(result?.coverage.limitations
      .filter((value) => value.material)
      .map((value) => value.kind) ?? []),
  ];
  return {
    targetKind: "worktree",
    baseCommitId: inspection.baseCommitId,
    targetPath: location.repositoryPath,
    changeKind: target?.changeKind ?? (location.targetState === "untracked" ? "added" : "modified"),
    staging: target?.staging ?? "unknown",
    coveredSpans: construction.queriedSpans,
    hunks: target?.relevantHunks.map((hunk) => ({
      operation: hunk.operation,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      queriedSpans: hunk.queriedSpans,
      complete: true as const,
    })) ?? [],
    status: result?.status ?? (construction.status === "ready" ? "unavailable" : construction.status),
    ...(result === undefined ? {} : { result }),
    construction: construction.status,
    limitations: [...new Set(limitations)],
  };
}

export async function analyzeLocation(
  input: string,
  options: AnalyzeLocationOptions = {},
): Promise<WhylineReport> {
  const parsed = parseLocation(input);
  const runner = options.git ?? defaultGitProcess;
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const repository = await discoverRepositoryContext(runner, currentDirectory);
  const source = await resolveCurrentSource(parsed.file, repository, runner, currentDirectory);
  const location = resolvedCodeLocationFromSource(parsed, source);
  const limitations = baseLimitations();

  let provenance: GitProvenance;
  let worktreeInspection: Awaited<ReturnType<typeof inspectWorktreeChange>> | undefined;
  if (location.targetState === "untracked") {
    limitations.push("The target file is untracked, so no Git commit can be attributed.");
    worktreeInspection = await inspectWorktreeChange(
      runner,
      repository,
      source,
      [location.requestedLine],
    );
    provenance = {
      state: "uncommitted",
      targetDirty: true,
      targetState: location.targetState,
      blame: null,
      commit: null,
      parent: null,
      changedPaths: [],
      relevantHunks: [],
      limitations,
    };
  } else {
    const blame = await blameLine(
      runner,
      repository,
      location.repositoryPath,
      location.requestedLine,
    );
    if (blame.uncommitted) {
      limitations.push("The requested line is uncommitted; no commit attribution was fabricated.");
      worktreeInspection = await inspectWorktreeChange(
        runner,
        repository,
        source,
        [location.requestedLine],
      );
      provenance = {
        state: "uncommitted",
        targetDirty: location.targetDirty,
        targetState: location.targetState,
        blame,
        commit: null,
        parent: null,
        changedPaths: [],
        relevantHunks: [],
        limitations,
      };
    } else {
      const inspection = await inspectCommit(runner, repository, location, blame);
      provenance = {
        state: "committed",
        targetDirty: location.targetDirty,
        targetState: location.targetState,
        blame,
        commit: inspection.commit,
        parent: inspection.parent,
        changedPaths: inspection.changedPaths,
        relevantHunks: inspection.relevantHunks,
        limitations: [...limitations, ...inspection.limitations],
      };
    }
  }

  let ancestry: WhylineReport["ancestry"];
  let correlation: WhylineReport["correlation"];
  let worktreeCorrelation: WhylineReport["worktreeCorrelation"];
  let preparedCodex;
  let worktreeExpectation;
  if (provenance.state === "committed") {
    const target = buildCorrelationTarget(repository, location, provenance);
    const correlationPromise = target === null
      ? Promise.resolve(undefined)
      : correlateCodex({
          target,
          location,
          repository,
          git: runner,
          ...(options.agentHistorySource === undefined ? {} : { agentHistorySource: options.agentHistorySource }),
          ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
          ...(options.correlationTelemetry === undefined ? {} : { telemetry: options.correlationTelemetry }),
        });
    [ancestry, correlation] = await Promise.all([
      traceLineAncestry(runner, repository, location, provenance),
      correlationPromise,
    ]);
  } else if (worktreeInspection !== undefined) {
    const construction = worktreeInspection.constructions[0]!;
    if (construction.status === "ready") {
      preparedCodex = await prepareCodexEvidence({
        repository,
        git: runner,
        ...(options.agentHistorySource === undefined ? {} : { agentHistorySource: options.agentHistorySource }),
        ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
      });
      const result = await projectPreparedCodex(preparedCodex, construction.target, location);
      worktreeCorrelation = worktreeCorrelationReport(location, worktreeInspection, construction, result);
      worktreeExpectation = {
        queriedLines: [location.requestedLine],
        evidenceDigest: worktreeInspection.evidenceDigest,
      };
    } else {
      worktreeCorrelation = worktreeCorrelationReport(location, worktreeInspection, construction);
    }
  }

  const report: WhylineReport = {
    repository,
    location,
    provenance,
    ...(ancestry === undefined ? {} : { ancestry }),
    ...(correlation === undefined ? {} : { correlation }),
    ...(worktreeCorrelation === undefined ? {} : { worktreeCorrelation }),
  };
  await options.hooks?.beforeFinalVerification?.(report);
  await verifyAnalysisStability({
    runner,
    repository,
    location,
    ...(worktreeExpectation === undefined ? {} : { worktree: [worktreeExpectation] }),
    ...(preparedCodex === undefined ? {} : { preparedCodex }),
  });
  return report;
}
