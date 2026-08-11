import type {
  GitResult,
  GitRunner,
} from "./git-process.js";
import {
  inspectCommitEvidence,
  loadCommitMetadata,
  selectParent,
  type CommitInspection,
} from "./inspect-commit.js";
import type {
  GitCommit,
  ParentSelection,
  RepositoryContext,
  ResolvedCodeLocation,
  ResolvedRangeCodeLocation,
} from "../provenance/model.js";
import type {
  RangeLineAttribution,
  RangeLineInspection,
} from "../provenance/range-model.js";

class MemoizedGitRunner implements GitRunner {
  private readonly cache = new Map<string, Promise<GitResult>>();

  public constructor(private readonly delegate: GitRunner) {}

  public run(
    args: readonly string[],
    options: { readonly cwd: string; readonly input?: Uint8Array },
  ): Promise<GitResult> {
    if (options.input !== undefined) {
      return this.delegate.run(args, options);
    }
    const key = options.cwd + "\u0000" + args.join("\u0000");
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const result = this.delegate.run(args, options);
    this.cache.set(key, result);
    return result;
  }
}

function parentKey(parent: ParentSelection): string {
  switch (parent.kind) {
    case "root":
      return "root";
    case "commit":
      return "commit:" + parent.commitId;
    case "ambiguous":
      return "ambiguous:" + parent.parentIds.join(",");
    case "unavailable":
      return "unavailable:" + parent.reason;
  }
}

function rangeLineLocation(
  location: ResolvedRangeCodeLocation,
  fact: RangeLineAttribution,
): ResolvedCodeLocation {
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

interface PreparedFact {
  readonly fact: RangeLineAttribution;
  readonly commit: GitCommit;
  readonly parent: ParentSelection;
}

interface InspectionGroup {
  readonly key: string;
  readonly facts: readonly PreparedFact[];
}

function preparedKey(value: PreparedFact): string {
  return [
    value.commit.id,
    value.fact.blame.filename,
    parentKey(value.parent),
  ].join("\u0000");
}

function selectParentForRange(
  context: RepositoryContext,
  commit: GitCommit,
  fact: RangeLineAttribution,
): ParentSelection {
  return context.isShallow && commit.parents.length === 0
    ? { basis: "derived", kind: "unavailable", reason: "shallow-history" }
    : selectParent(commit, fact.blame);
}

function asRangeInspection(
  inspection: CommitInspection,
): RangeLineInspection {
  return {
    commit: inspection.commit,
    parent: inspection.parent,
    changedPaths: inspection.changedPaths,
    relevantHunks: inspection.relevantHunks,
    limitations: inspection.limitations,
  };
}

export async function inspectRangeFacts(
  runner: GitRunner,
  context: RepositoryContext,
  location: ResolvedRangeCodeLocation,
  facts: readonly RangeLineAttribution[],
): Promise<ReadonlyMap<number, RangeLineInspection>> {
  const memoized = new MemoizedGitRunner(runner);
  const commitIds = [...new Set(
    facts
      .filter((fact) => !fact.blame.uncommitted)
      .map((fact) => fact.blame.objectId),
  )];
  const commits = new Map<string, GitCommit>();
  await Promise.all(commitIds.map(async (commitId) => {
    commits.set(commitId, await loadCommitMetadata(memoized, context, commitId));
  }));

  const prepared: PreparedFact[] = [];
  const result = new Map<number, RangeLineInspection>();
  for (const fact of facts) {
    if (fact.blame.uncommitted) {
      result.set(fact.queryLine, {
        commit: null,
        parent: null,
        changedPaths: [],
        relevantHunks: [],
        limitations: ["The queried line is uncommitted; no commit was inspected."],
      });
      continue;
    }
    const commit = commits.get(fact.blame.objectId);
    if (commit === undefined) {
      throw new Error("range commit metadata is missing");
    }
    prepared.push({
      fact,
      commit,
      parent: selectParentForRange(context, commit, fact),
    });
  }

  const groups = new Map<string, InspectionGroup>();
  for (const value of prepared) {
    const key = preparedKey(value);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, facts: [value] });
    } else {
      groups.set(key, { key, facts: [...existing.facts, value] });
    }
  }

  await Promise.all([...groups.values()].map(async (group) => {
    const representative = group.facts[0];
    if (representative === undefined) throw new Error("range inspection group is empty");
    const inspection = await inspectCommitEvidence(
      memoized,
      context,
      rangeLineLocation(location, representative.fact),
      representative.fact.blame,
      representative.commit,
      representative.parent,
      new Set(group.facts.map((value) => value.fact.queryLine)),
    );
    const normalized = asRangeInspection(inspection);
    for (const value of group.facts) {
      result.set(value.fact.queryLine, normalized);
    }
  }));

  return result;
}
