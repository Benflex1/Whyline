import { defaultGitProcess, type GitRunner } from "../git/git-process.js";
import { blameRange } from "../git/blame-range.js";
import { discoverRepositoryContext } from "../git/repository-context.js";
import { inspectRangeFacts } from "../git/inspect-range.js";
import {
  createRangeAncestryTraceCache,
  traceRangeGroupAncestry,
} from "../git/trace-range-ancestry.js";
import {
  resolveCurrentSource,
  resolveRangeLocation,
  resolvedRangeLocationFromSource,
  type CurrentSourceSnapshot,
} from "../location/resolve-location.js";
import { parseLocationQuery } from "../location/parse-location.js";
import type { AgentHistorySource } from "../agents/agent-history-source.js";
import { buildCorrelationTarget } from "./build-correlation-target.js";
import type { WorktreeTargetConstruction } from "../correlation/model.js";
import {
  prepareCodexEvidence,
  projectPreparedCodex,
} from "./correlate-codex.js";
import type { CorrelationTelemetry } from "./correlation-telemetry.js";
import type {
  GitBlameAttribution,
  GitProvenance,
  RepositoryContext,
  ResolvedCodeLocation,
  ResolvedRangeCodeLocation,
} from "./model.js";
import {
  groupTextualAttributions,
  type RangeAncestryCoverage,
  type RangeCorrelationGroup,
  type RangeLineSpan,
  type RangeLineAttribution,
  type RangeLineInspection,
  type RangeTextualGroup,
  type WhylineRangeReport,
} from "./range-model.js";
import { inspectWorktreeChange } from "../git/inspect-worktree-change.js";
import { OperationalError, InvalidInputError } from "../whyline-error.js";
import { verifyAnalysisStability } from "./verify-analysis-stability.js";

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
  /** Invocation-local source reuse for symbol and range equivalence. */
  readonly sourceSnapshot?: CurrentSourceSnapshot;
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

export async function analyzeResolvedRange(
  repository: RepositoryContext,
  location: ResolvedRangeCodeLocation,
  options: AnalyzeRangeOptions = {},
): Promise<WhylineRangeReport> {
  const runner = options.git ?? defaultGitProcess;
  const source = options.sourceSnapshot ?? await resolveCurrentSource(
    location.absolutePath,
    repository,
    runner,
    options.currentDirectory ?? repository.worktreeRoot,
  );

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
  const uncommittedLines = facts
    .filter((fact) => fact.blame.uncommitted)
    .map((fact) => fact.queryLine);
  const worktreeInspection = uncommittedLines.length === 0
    ? undefined
    : await inspectWorktreeChange(runner, repository, source, uncommittedLines);
  const textualGroups = groupTextualAttributions(facts, inspections);
  const committedGroups = textualGroups.filter((group) => group.state === "committed");
  const ancestry = new Map<string, RangeAncestryCoverage>();
  const correlations: RangeCorrelationGroup[] = [];
  const ancestryCache = createRangeAncestryTraceCache();

  for (const group of textualGroups.filter((value) => value.state === "uncommitted")) {
    ancestry.set(group.id, notRunCoverage(
      group,
      "not-run",
      "Uncommitted lines do not receive Git ancestry or Codex attribution.",
    ));
  }

  interface WorktreeAnalysisGroup {
    readonly groupId: string;
    readonly textualGroup: RangeTextualGroup;
    readonly spans: readonly RangeLineSpan[];
    readonly construction: WorktreeTargetConstruction;
  }

  const worktreeGroups: WorktreeAnalysisGroup[] = [];
  if (worktreeInspection !== undefined) {
    worktreeInspection.constructions.forEach((construction, index) => {
      const textualGroup = textualGroups.find((group) =>
        group.state === "uncommitted"
          && construction.queriedSpans.every((span) => group.spans.some((candidate) =>
            span.startLine >= candidate.startLine && span.endLine <= candidate.endLine)));
      if (textualGroup === undefined) return;
      worktreeGroups.push({
        groupId: `analysis-${textualGroup.id}-${index + 1}`,
        textualGroup,
        spans: construction.queriedSpans,
        construction,
      });
    });
  }

  const committedAnalysisGroups = committedGroups.map((group) => ({
    kind: "commit" as const,
    groupId: group.id,
    textualGroup: group,
    spans: group.spans,
  }));
  const readyWorktreeGroups = worktreeGroups.filter((group) => group.construction.status === "ready");
  const budgetGroups = [
    ...committedAnalysisGroups,
    ...readyWorktreeGroups.map((group) => ({
      kind: "worktree" as const,
      groupId: group.groupId,
      textualGroup: group.textualGroup,
      spans: group.spans,
      construction: group.construction,
    })),
  ].sort((left, right) =>
    (left.spans[0]?.startLine ?? Number.MAX_SAFE_INTEGER)
      - (right.spans[0]?.startLine ?? Number.MAX_SAFE_INTEGER)
      || left.groupId.localeCompare(right.groupId));
  const deepGroups = budgetGroups.slice(0, MAX_DEEP_GROUPS);
  const workBoundGroups = budgetGroups.slice(MAX_DEEP_GROUPS);

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

  for (const group of worktreeGroups.filter((value) => value.construction.status !== "ready")) {
    const construction = group.construction;
    if (construction.status === "ready") continue;
    correlations.push({
      groupId: group.groupId,
      analysisGroupId: group.groupId,
      textualGroupId: group.textualGroup.id,
      targetKind: "worktree",
      spans: group.spans,
      status: construction.status,
      limitations: construction.limitations,
    });
  }

  for (const entry of deepGroups) {
    const group = entry.textualGroup;
    const groupLocation = representativeLocation(location, group);
    if (entry.kind === "worktree") {
      const construction = entry.construction;
      if (prepared === undefined || construction.status !== "ready") {
        correlations.push({
          groupId: entry.groupId,
          analysisGroupId: entry.groupId,
          textualGroupId: group.id,
          targetKind: "worktree",
          spans: entry.spans,
          status: "not-run",
          limitations: ["Codex projection was not available for this worktree group."],
        });
      } else {
        const result = await projectPreparedCodex(prepared, construction.target, groupLocation);
        correlations.push({
          groupId: entry.groupId,
          analysisGroupId: entry.groupId,
          textualGroupId: group.id,
          targetKind: "worktree",
          spans: entry.spans,
          status: result.status,
          result,
          limitations: result.coverage.limitations
            .filter((limitation) => limitation.material)
            .map((limitation) => limitation.kind),
        });
      }
      continue;
    }

    const groupTarget = buildCorrelationTarget(repository, groupLocation, groupProvenance(location, group));
    const ancestryPromise = traceRangeGroupAncestry(runner, repository, location, group, ancestryCache);
    const correlationPromise = prepared === undefined || groupTarget === null
      ? Promise.resolve<RangeCorrelationGroup>({
        groupId: entry.groupId,
        analysisGroupId: entry.groupId,
        textualGroupId: group.id,
        targetKind: "commit",
        spans: entry.spans,
        status: "not-run",
        limitations: ["Codex projection was not available for this committed group."],
      })
      : projectPreparedCodex(prepared, groupTarget, groupLocation).then((result) => ({
        groupId: entry.groupId,
        analysisGroupId: entry.groupId,
        textualGroupId: group.id,
        targetKind: "commit" as const,
        spans: entry.spans,
        status: result.status,
        result,
        limitations: result.coverage.limitations
          .filter((limitation) => limitation.material)
          .map((limitation) => limitation.kind),
      }));
    const [groupAncestry, groupCorrelation] = await Promise.all([ancestryPromise, correlationPromise]);
    ancestry.set(group.id, groupAncestry);
    correlations.push(groupCorrelation);
  }

  for (const entry of workBoundGroups) {
    const message = "Deep ancestry and Codex analysis was omitted by the shared 24-analysis-group work bound.";
    if (entry.kind === "commit") {
      ancestry.set(entry.textualGroup.id, notRunCoverage(entry.textualGroup, "work-bound", message));
    }
    correlations.push({
      groupId: entry.groupId,
      analysisGroupId: entry.groupId,
      textualGroupId: entry.textualGroup.id,
      targetKind: entry.kind,
      spans: entry.spans,
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
      readyWorktreeGroups: readyWorktreeGroups.length,
      workBoundGroups: workBoundGroups.length,
      groupLimitOmissions: workBoundGroups.length,
      uncommittedGroups: textualGroups.filter((group) => group.state === "uncommitted").length,
    },
  };
  await options.hooks?.beforeFinalVerification?.(report);
  await verifyAnalysisStability({
    runner,
    repository,
    location,
    ...(worktreeInspection === undefined ? {} : {
      worktree: [{
        queriedLines: uncommittedLines,
        evidenceDigest: worktreeInspection.evidenceDigest,
      }],
    }),
    ...(prepared === undefined ? {} : { preparedCodex: prepared }),
  });
  return report;
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
  const source = await resolveCurrentSource(parsed.file, repository, runner, currentDirectory);
  const location = resolvedRangeLocationFromSource(parsed, source);
  return analyzeResolvedRange(repository, location, { ...options, sourceSnapshot: source });
}
