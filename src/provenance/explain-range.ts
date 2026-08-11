import { defaultGitProcess, requireGitSuccess, type GitRunner } from "../git/git-process.js";
import { blameRange } from "../git/blame-range.js";
import { discoverRepositoryContext, readTargetStatus } from "../git/repository-context.js";
import { inspectRangeFacts } from "../git/inspect-range.js";
import { traceRangeGroupAncestry } from "../git/trace-range-ancestry.js";
import {
  currentLocationSnapshot,
  resolveRangeLocation,
  snapshotsEqual,
} from "../location/resolve-location.js";
import { parseLocationQuery } from "../location/parse-location.js";
import type { AgentHistorySource } from "../agents/agent-history-source.js";
import { buildCorrelationTarget } from "./build-correlation-target.js";
import {
  prepareCodexEvidence,
  projectPreparedCodex,
} from "./correlate-codex.js";
import type { CorrelationTelemetry } from "./correlation-telemetry.js";
import type {
  GitBlameAttribution,
  GitProvenance,
  ResolvedCodeLocation,
} from "./model.js";
import {
  groupTextualAttributions,
  type RangeAncestryCoverage,
  type RangeCorrelationGroup,
  type RangeLineAttribution,
  type RangeLineInspection,
  type RangeTextualGroup,
  type WhylineRangeReport,
} from "./range-model.js";
import { OperationalError, InvalidInputError } from "../whyline-error.js";

const UNCOMMITTED_OBJECT = "0000000000000000000000000000000000000000";
const MAX_DEEP_GROUPS = 24;

export interface RangeAnalysisHooks {
  readonly beforeFinalVerification?: (report: WhylineRangeReport) => void | Promise<void>;
}

export interface AnalyzeRangeOptions {
  readonly currentDirectory?: string;
  readonly git?: GitRunner;
  readonly hooks?: RangeAnalysisHooks;
  readonly agentHistorySource?: AgentHistorySource;
  readonly codexHome?: string;
  readonly correlationTelemetry?: CorrelationTelemetry;
}

function uncommittedFact(
  location: Awaited<ReturnType<typeof resolveRangeLocation>>,
  queryLine: number,
): RangeLineAttribution {
  const offset = queryLine - location.startLine;
  const lineContent = location.lineContents[offset] ?? "";
  const blame: GitBlameAttribution = {
    basis: "fact",
    objectId: UNCOMMITTED_OBJECT,
    uncommitted: true,
    originalLine: queryLine,
    finalLine: queryLine,
    authorName: null,
    authorEmail: null,
    authorTime: null,
    authorTimezone: null,
    committerName: null,
    committerEmail: null,
    committerTime: null,
    committerTimezone: null,
    filename: location.repositoryPath,
    previousCommit: null,
    previousPath: null,
    blobId: null,
    lineContent,
  };
  return { queryLine, blame };
}

function representativeLocation(
  location: Awaited<ReturnType<typeof resolveRangeLocation>>,
  group: RangeTextualGroup,
): ResolvedCodeLocation {
  const fact = group.lines[0];
  if (fact === undefined) {
    throw new OperationalError("range textual group was empty");
  }
  const offset = fact.queryLine - location.startLine;
  return {
    input: location.input,
    absolutePath: location.absolutePath,
    repositoryPath: location.repositoryPath,
    requestedLine: fact.queryLine,
    lineContent: location.lineContents[offset] ?? fact.blame.lineContent,
    lineDigest: location.lineDigests[offset] ?? "",
    fileSnapshot: location.fileSnapshot,
    targetState: location.targetState,
    targetDirty: location.targetDirty,
  };
}

function groupProvenance(
  location: Awaited<ReturnType<typeof resolveRangeLocation>>,
  group: RangeTextualGroup,
): GitProvenance {
  const fact = group.lines[0];
  return {
    state: "committed",
    targetDirty: location.targetDirty,
    targetState: location.targetState,
    blame: fact?.blame ?? null,
    commit: group.commit,
    parent: group.parent,
    changedPaths: group.changedPaths,
    relevantHunks: group.relevantHunks,
    limitations: group.limitations,
  };
}

function notRunCoverage(
  group: RangeTextualGroup,
  status: "not-run" | "work-bound",
  message: string,
): RangeAncestryCoverage {
  return {
    segments: group.spans.map((span) => ({
      span,
      status,
      limitations: [message],
    })),
    limitations: [message],
  };
}

async function verifyStableRangeState(
  runner: GitRunner,
  report: WhylineRangeReport,
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

export async function analyzeRange(
  input: string,
  options: AnalyzeRangeOptions = {},
): Promise<WhylineRangeReport> {
  const parsed = parseLocationQuery(input);
  if (parsed.kind !== "range") {
    throw new InvalidInputError("range analysis requires <file>:<start>-<end>");
  }
  const runner = options.git ?? defaultGitProcess;
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const repository = await discoverRepositoryContext(runner, currentDirectory);
  const location = await resolveRangeLocation(parsed, repository, runner, currentDirectory);

  const facts = location.targetState === "untracked"
    ? Array.from(
      { length: location.endLine - location.startLine + 1 },
      (_value, index) => uncommittedFact(location, location.startLine + index),
    )
    : await blameRange(
      runner,
      repository,
      location.repositoryPath,
      location.startLine,
      location.endLine,
    );

  let inspections: ReadonlyMap<number, RangeLineInspection>;
  if (location.targetState === "untracked") {
    inspections = new Map(facts.map((fact) => [
      fact.queryLine,
      {
        commit: null,
        parent: null,
        changedPaths: [],
        relevantHunks: [],
        limitations: ["The target file is untracked; no Git commit was inspected."],
      } satisfies RangeLineInspection,
    ]));
  } else {
    inspections = await inspectRangeFacts(runner, repository, location, facts);
  }
  const textualGroups = groupTextualAttributions(facts, inspections);
  const committedGroups = textualGroups.filter((group) => group.state === "committed");
  const deepGroups = committedGroups.slice(0, MAX_DEEP_GROUPS);
  const workBoundGroups = committedGroups.slice(MAX_DEEP_GROUPS);
  const ancestry = new Map<string, RangeAncestryCoverage>();
  const correlations: RangeCorrelationGroup[] = [];

  for (const group of textualGroups.filter((value) => value.state === "uncommitted")) {
    ancestry.set(group.id, notRunCoverage(
      group,
      "not-run",
      "Uncommitted lines do not receive Git ancestry or Codex attribution.",
    ));
  }

  let prepared;
  if (deepGroups.length > 0) {
    prepared = await prepareCodexEvidence({
      repository,
      git: runner,
      ...(options.agentHistorySource === undefined ? {} : { agentHistorySource: options.agentHistorySource }),
      ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
      ...(options.correlationTelemetry === undefined ? {} : { telemetry: options.correlationTelemetry }),
    });
  }

  for (const group of deepGroups) {
    const groupLocation = representativeLocation(location, group);
    const groupTarget = buildCorrelationTarget(
      repository,
      groupLocation,
      groupProvenance(location, group),
    );
    const ancestryPromise = traceRangeGroupAncestry(runner, repository, location, group);
    const correlationPromise = prepared === undefined || groupTarget === null
      ? Promise.resolve<RangeCorrelationGroup>({
        groupId: group.id,
        spans: group.spans,
        status: "not-run",
        limitations: ["Codex projection was not available for this committed group."],
      })
      : projectPreparedCodex(prepared, groupTarget, groupLocation).then((result) => ({
        groupId: group.id,
        spans: group.spans,
        status: result.status,
        result,
        limitations: result.coverage.limitations
          .filter((limitation) => limitation.material)
          .map((limitation) => limitation.kind),
      }));
    const [groupAncestry, groupCorrelation] = await Promise.all([
      ancestryPromise,
      correlationPromise,
    ]);
    ancestry.set(group.id, groupAncestry);
    correlations.push(groupCorrelation);
  }

  for (const group of workBoundGroups) {
    const message = "Deep ancestry and Codex analysis was omitted by the 24 committed textual-group work bound.";
    ancestry.set(group.id, notRunCoverage(group, "work-bound", message));
    correlations.push({
      groupId: group.id,
      spans: group.spans,
      status: "work-bound",
      limitations: [message],
    });
  }

  const report: WhylineRangeReport = {
    repository,
    location,
    lineAttributions: facts,
    textualGroups,
    ancestry,
    correlations: correlations.sort((left, right) => {
      const leftLine = left.spans[0]?.startLine ?? Number.MAX_SAFE_INTEGER;
      const rightLine = right.spans[0]?.startLine ?? Number.MAX_SAFE_INTEGER;
      return leftLine - rightLine;
    }),
    coverage: {
      committedGroups: committedGroups.length,
      deepAnalyzedGroups: deepGroups.length,
      workBoundGroups: workBoundGroups.length,
      uncommittedGroups: textualGroups.filter((group) => group.state === "uncommitted").length,
    },
  };
  await options.hooks?.beforeFinalVerification?.(report);
  await verifyStableRangeState(runner, report);
  return report;
}

