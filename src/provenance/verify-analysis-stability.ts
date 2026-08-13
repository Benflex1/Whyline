import { realpath } from "node:fs/promises";
import path from "node:path";

import type { GitRunner } from "../git/git-process.js";
import { requireGitSuccess } from "../git/git-process.js";
import { inspectWorktreeChange } from "../git/inspect-worktree-change.js";
import { readTargetStatus } from "../git/repository-context.js";
import {
  resolveCurrentSource,
  currentLocationSnapshot,
  snapshotsEqual,
} from "../location/resolve-location.js";
import type {
  RepositoryContext,
  ResolvedCodeLocation,
  ResolvedRangeCodeLocation,
} from "./model.js";
import type { PreparedCodexEvidence } from "./correlate-codex.js";
import { verifyPreparedCodexEvidenceStable } from "./correlate-codex.js";
import { OperationalError } from "../whyline-error.js";

export interface WorktreeStabilityExpectation {
  readonly queriedLines: readonly number[];
  readonly evidenceDigest: string;
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function verifyRepositoryIdentity(
  runner: GitRunner,
  repository: RepositoryContext,
): Promise<void> {
  const commands = await Promise.all([
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ["rev-parse", "--show-object-format"],
  ].map(async (args) => {
    try {
      return await runner.run(args, { cwd: repository.worktreeRoot });
    } catch {
      return null;
    }
  }));
  if (commands.some((value) => value === null || value.exitCode !== 0)) {
    throw new OperationalError("repository changed during analysis");
  }
  const values = commands.map((value) => value?.stdout.toString("utf8").trim() ?? "");
  if (values.some((value) => value.length === 0)
    || await canonicalPath(values[0] as string) !== await canonicalPath(repository.worktreeRoot)
    || await canonicalPath(values[1] as string) !== await canonicalPath(repository.gitDir)
    || await canonicalPath(values[2] as string) !== await canonicalPath(repository.commonGitDir)
    || values[3] !== repository.objectFormat) {
    throw new OperationalError("repository changed during analysis");
  }
}

export async function verifyAnalysisStability(input: {
  readonly runner: GitRunner;
  readonly repository: RepositoryContext;
  readonly location: ResolvedCodeLocation | ResolvedRangeCodeLocation;
  readonly worktree?: readonly WorktreeStabilityExpectation[];
  readonly preparedCodex?: PreparedCodexEvidence;
}): Promise<void> {
  const { runner, repository, location } = input;
  const headResult = await requireGitSuccess(
    runner,
    ["rev-parse", "--verify", "HEAD"],
    repository.worktreeRoot,
    "analysis stability check",
  );
  if (headResult.stdout.toString("utf8").trim() !== repository.headCommit) {
    throw new OperationalError("repository changed during analysis");
  }

  const branchResult = await runner.run(
    ["symbolic-ref", "-q", "--short", "HEAD"],
    { cwd: repository.worktreeRoot },
  );
  if (branchResult.exitCode > 1) {
    throw new OperationalError("analysis stability check could not determine the branch");
  }
  const branch = branchResult.exitCode === 1
    ? null
    : branchResult.stdout.toString("utf8").trim();
  if (branch !== repository.branch) throw new OperationalError("repository changed during analysis");

  let currentSnapshot;
  try {
    currentSnapshot = await currentLocationSnapshot(location);
  } catch {
    throw new OperationalError("repository changed during analysis");
  }
  if (!snapshotsEqual(currentSnapshot, location.fileSnapshot)) {
    throw new OperationalError("repository changed during analysis");
  }

  const currentStatus = await readTargetStatus(runner, repository, location.repositoryPath);
  if (currentStatus.state !== location.targetState || currentStatus.dirty !== location.targetDirty) {
    throw new OperationalError("repository changed during analysis");
  }

  if (input.worktree !== undefined && input.worktree.length > 0) {
    await verifyRepositoryIdentity(runner, repository);
    const source = await resolveCurrentSource(
      location.absolutePath,
      repository,
      runner,
      repository.worktreeRoot,
    );
    for (const expected of input.worktree) {
      const inspection = await inspectWorktreeChange(runner, repository, source, expected.queriedLines);
      if (inspection.evidenceDigest !== expected.evidenceDigest) {
        throw new OperationalError("worktree changed during analysis");
      }
    }
  }

  if (input.preparedCodex !== undefined) {
    await verifyPreparedCodexEvidenceStable(input.preparedCodex);
  }
}
