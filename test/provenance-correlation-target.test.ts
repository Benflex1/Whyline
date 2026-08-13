import assert from "node:assert/strict";
import test from "node:test";

import { buildCorrelationTarget } from "../src/provenance/build-correlation-target.js";
import type {
  CorrelationRepositoryIdentity,
  WorktreeCorrelationTarget,
  WorktreeTargetConstruction,
} from "../src/correlation/model.js";
import type {
  GitProvenance,
  RepositoryContext,
  ResolvedCodeLocation,
} from "../src/provenance/model.js";

const repositoryIdentity: CorrelationRepositoryIdentity = {
  worktreeRoot: "/workspace/project",
  gitDir: "/workspace/project/.git",
  commonGitDir: "/workspace/project/.git",
  objectFormat: "sha1",
  worktrees: [{ path: "/workspace/project", commonGitDir: "/workspace/project/.git" }],
};

const worktreeHunk = {
  basis: "derived" as const,
  oldPath: "src/target.ts",
  newPath: "src/target.ts",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 3,
  targetLineKind: "added" as const,
  addedLineFingerprints: ["added-a", "added-b"],
  deletedLineFingerprints: [],
  distinctiveAddedLineFingerprints: ["added-a", "added-b"],
  distinctiveDeletedLineFingerprints: [],
  truncated: false,
  operation: "update" as const,
  queriedSpans: [{ startLine: 1, endLine: 3 }],
  currentLineFingerprints: ["added-a", "added-b"],
  currentDistinctiveLineFingerprints: ["added-a", "added-b"],
  currentLineAlphanumericCounts: [20, 20],
  complete: true as const,
};

const worktreeTarget: WorktreeCorrelationTarget = {
  kind: "worktree",
  basis: "derived",
  repository: repositoryIdentity,
  baseCommitId: "a".repeat(40),
  targetPath: "src/target.ts",
  changeKind: "modified",
  staging: "unstaged",
  queriedSpans: [{ startLine: 1, endLine: 3 }],
  relevantHunks: [worktreeHunk],
  targetSnapshot: {
    baseCommitId: "a".repeat(40),
    repositoryPath: "src/target.ts",
    changeKind: "modified",
    fileSnapshot: { size: 1, mtimeMs: 1, ino: 1, dev: 1, digest: "file-digest" },
    evidenceDigest: "evidence-digest",
  },
};

const worktreeConstructionFixtures: readonly WorktreeTargetConstruction[] = [
  { status: "ready", queriedSpans: worktreeTarget.queriedSpans, target: worktreeTarget },
  {
    status: "insufficient",
    queriedSpans: worktreeTarget.queriedSpans,
    reason: "query-not-current-side-change",
    limitations: ["fixture"],
  },
  {
    status: "unavailable",
    queriedSpans: worktreeTarget.queriedSpans,
    reason: "incomplete-diff",
    limitations: ["fixture"],
  },
  {
    status: "work-bound",
    queriedSpans: worktreeTarget.queriedSpans,
    reason: "hunk-too-large",
    limitations: ["fixture"],
  },
];

type WorktreeShapeChecks = [
  "commit" extends keyof WorktreeCorrelationTarget ? false : true,
  "selectedParentId" extends keyof WorktreeCorrelationTarget ? false : true,
  "blamedPath" extends keyof WorktreeCorrelationTarget ? false : true,
  "changedPaths" extends keyof WorktreeCorrelationTarget ? false : true,
  "pathAliases" extends keyof WorktreeCorrelationTarget ? false : true,
];
const worktreeShapeChecks: WorktreeShapeChecks = [true, true, true, true, true];

void worktreeConstructionFixtures;
void worktreeShapeChecks;

function repository(): RepositoryContext {
  return {
    worktreeRoot: "/workspace/project",
    gitDir: "/workspace/project/.git",
    commonGitDir: "/workspace/project/.git",
    objectFormat: "sha1",
    isShallow: false,
    headCommit: "a".repeat(40),
    branch: "main",
    worktrees: [{
      path: "/workspace/project",
      headCommit: "a".repeat(40),
      branch: "main",
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    }],
  };
}

function location(): ResolvedCodeLocation {
  return {
    input: "src/target.ts:1",
    absolutePath: "/workspace/project/src/target.ts",
    repositoryPath: "src/target.ts",
    requestedLine: 1,
    lineContent: "const target = true;",
    lineDigest: "line-digest",
    fileSnapshot: { size: 1, mtimeMs: 1, ino: 1, dev: 1, digest: "file-digest" },
    targetState: "clean",
    targetDirty: false,
  };
}

function provenance(): GitProvenance {
  return {
    state: "committed",
    targetDirty: false,
    targetState: "clean",
    blame: null,
    commit: {
      basis: "fact",
      id: "a".repeat(40),
      parents: [],
      authorName: "Fixture Author",
      authorEmail: "author@example.test",
      authoredAt: "2026-08-08T00:00:00.000Z",
      committerName: "Fixture Author",
      committerEmail: "author@example.test",
      committedAt: "2026-08-08T00:00:00.000Z",
      subject: "target",
      body: "",
      bodyTruncated: false,
    },
    parent: { basis: "derived", kind: "root" },
    changedPaths: [{
      basis: "derived",
      kind: "modified",
      oldPath: "src/target.ts",
      newPath: "src/target.ts",
      similarity: null,
    }],
    relevantHunks: [{
      basis: "derived",
      oldPath: "src/target.ts",
      newPath: "src/target.ts",
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 129,
      targetLineKind: "added",
      lines: Array.from({ length: 129 }, (_, index) => ({
        kind: "added" as const,
        text: `const boundedSignal${index} = "${index}";`,
      })),
      raw: "must not enter correlation target",
      truncated: false,
    }],
    limitations: [],
  };
}

test("bounded Git fingerprints mark the hunk truncated without retaining raw text", () => {
  const target = buildCorrelationTarget(repository(), location(), provenance());
  assert.ok(target !== null);
  assert.equal(target.kind, "commit");
  assert.equal(target.repository.gitDir, repository().gitDir);
  const hunk = target.relevantHunks[0];
  assert.ok(hunk !== undefined);
  assert.equal(hunk.addedLineFingerprints.length, 128);
  assert.equal(hunk.truncated, true);
  assert.equal("raw" in hunk, false);
});
