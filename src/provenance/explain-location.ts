import type { GitRunner } from "../git/git-process.js";
import { defaultGitProcess, requireGitSuccess } from "../git/git-process.js";
import { blameLine } from "../git/blame-line.js";
import { discoverRepositoryContext, readTargetStatus } from "../git/repository-context.js";
import { inspectCommit } from "../git/inspect-commit.js";
import { currentLocationSnapshot, resolveLocation, snapshotsEqual } from "../location/resolve-location.js";
import { parseLocation } from "../location/parse-location.js";
import type { AgentHistorySource } from "../agents/agent-history-source.js";
import { correlateCodex } from "./correlate-codex.js";
import type { CorrelationTelemetry } from "./correlation-telemetry.js";
import { buildCorrelationTarget } from "./build-correlation-target.js";
import { traceLineAncestry } from "../git/trace-line-ancestry.js";
import type {
  GitProvenance,
  WhylineReport,
} from "./model.js";
import { OperationalError } from "../whyline-error.js";

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

async function verifyStableState(
  runner: GitRunner,
  report: WhylineReport,
): Promise<void> {
  const headResult = await requireGitSuccess(
    runner,
    ["rev-parse", "--verify", "HEAD"],
    report.repository.worktreeRoot,
    "analysis stability check",
  );
  const currentHead = headResult.stdout.toString("utf8").trim();
  if (currentHead !== report.repository.headCommit) {
    throw new OperationalError("repository changed during analysis");
  }

  const branchResult = await runner.run(
    ["symbolic-ref", "-q", "--short", "HEAD"],
    { cwd: report.repository.worktreeRoot },
  );
  if (branchResult.exitCode > 1) {
    throw new OperationalError("analysis stability check could not determine the branch");
  }
  const currentBranch = branchResult.exitCode === 1
    ? null
    : branchResult.stdout.toString("utf8").trim();
  if (currentBranch !== report.repository.branch) {
    throw new OperationalError("repository changed during analysis");
  }

  let currentSnapshot;
  try {
    currentSnapshot = await currentLocationSnapshot(report.location);
  } catch {
    throw new OperationalError("repository changed during analysis");
  }
  if (!snapshotsEqual(currentSnapshot, report.location.fileSnapshot)) {
    throw new OperationalError("repository changed during analysis");
  }

  const currentStatus = await readTargetStatus(
    runner,
    report.repository,
    report.location.repositoryPath,
  );
  if (currentStatus.state !== report.location.targetState
    || currentStatus.dirty !== report.location.targetDirty) {
    throw new OperationalError("repository changed during analysis");
  }
}

export async function analyzeLocation(
  input: string,
  options: AnalyzeLocationOptions = {},
): Promise<WhylineReport> {
  const parsed = parseLocation(input);
  const runner = options.git ?? defaultGitProcess;
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const repository = await discoverRepositoryContext(runner, currentDirectory);
  const location = await resolveLocation(parsed, repository, runner, currentDirectory);
  const limitations = baseLimitations();

  let provenance: GitProvenance;
  if (location.targetState === "untracked") {
    limitations.push("The target file is untracked, so no Git commit can be attributed.");
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
  }

  const report: WhylineReport = {
    repository,
    location,
    provenance,
    ...(ancestry === undefined ? {} : { ancestry }),
    ...(correlation === undefined ? {} : { correlation }),
  };
  await options.hooks?.beforeFinalVerification?.(report);
  await verifyStableState(runner, report);
  return report;
}
