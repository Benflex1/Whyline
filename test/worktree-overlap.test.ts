import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPatchChange } from "../src/agents/agent-history-source.js";
import type {
  WorktreeCorrelationHunk,
  WorktreeCorrelationTarget,
} from "../src/correlation/model.js";
import {
  proveWorktreeOverlap,
  type WorktreePatchHunkEvidence,
} from "../src/correlation/worktree-overlap.js";

const PATH = "src/target.ts";

function hunk(overrides: Partial<WorktreeCorrelationHunk> = {}): WorktreeCorrelationHunk {
  return {
    basis: "derived",
    oldPath: PATH,
    newPath: PATH,
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 3,
    targetLineKind: "added",
    addedLineFingerprints: ["line-a", "line-b", "line-c"],
    deletedLineFingerprints: [],
    distinctiveAddedLineFingerprints: ["line-a", "line-b", "line-c"],
    distinctiveDeletedLineFingerprints: [],
    truncated: false,
    operation: "update",
    queriedSpans: [{ startLine: 11, endLine: 11 }],
    currentLineFingerprints: ["line-a", "line-b", "line-c"],
    currentDistinctiveLineFingerprints: ["line-a", "line-b", "line-c"],
    currentLineAlphanumericCounts: [20, 20, 20],
    complete: true,
    ...overrides,
  };
}

function target(overrides: Partial<WorktreeCorrelationTarget> = {}): WorktreeCorrelationTarget {
  const targetHunk = hunk();
  return {
    kind: "worktree",
    basis: "derived",
    repository: {
      worktreeRoot: "/workspace/project",
      gitDir: "/workspace/project/.git/worktrees/current",
      commonGitDir: "/workspace/project/.git",
      objectFormat: "sha1",
      worktrees: [{ path: "/workspace/project", commonGitDir: "/workspace/project/.git" }],
    },
    baseCommitId: "a".repeat(40),
    targetPath: PATH,
    changeKind: "modified",
    staging: "unstaged",
    queriedSpans: targetHunk.queriedSpans,
    relevantHunks: [targetHunk],
    targetSnapshot: {
      baseCommitId: "a".repeat(40),
      repositoryPath: PATH,
      changeKind: "modified",
      fileSnapshot: { size: 10, mtimeMs: 1, ino: 2, dev: 3, digest: "file" },
      evidenceDigest: "evidence",
    },
    ...overrides,
  };
}

function patchHunk(overrides: Partial<WorktreePatchHunkEvidence> = {}): WorktreePatchHunkEvidence {
  return {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 3,
    matchSide: "added",
    orderedLineFingerprints: ["line-a", "line-b", "line-c"],
    distinctiveLineFingerprints: ["line-a", "line-b", "line-c"],
    lineCount: 3,
    truncated: false,
    ...overrides,
  };
}

function change(overrides: Partial<AgentPatchChange> = {}): AgentPatchChange {
  return {
    path: PATH,
    changeType: "update",
    payloadKind: "unified-diff",
    payloadRecovered: true,
    payloadFingerprint: "payload",
    payloadTruncated: false,
    addedLineFingerprints: ["line-a", "line-b", "line-c"],
    matchLineFingerprints: ["line-a", "line-b", "line-c"],
    distinctiveLineFingerprints: ["line-a", "line-b", "line-c"],
    matchSide: "added",
    hunkRanges: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3 }],
    lineCount: 3,
    ...overrides,
  };
}

function prove(
  targetValue: WorktreeCorrelationTarget = target(),
  changeValue: AgentPatchChange = change(),
  patchHunkValue: WorktreePatchHunkEvidence = patchHunk(),
) {
  return proveWorktreeOverlap({ target: targetValue, change: changeValue, patchHunk: patchHunkValue });
}

test("proves one unique exact update alignment covering every queried line", () => {
  const result = prove();
  assert.equal(result.status, "exact");
  if (result.status !== "exact") return;
  assert.equal(result.comparison, "exact-line-fingerprints");
  assert.equal(result.matchedLineCount, 3);
  assert.equal(result.distinctiveLineCount, 3);
  assert.equal(result.alphanumericCount, 60);
  assert.deepEqual(result.coveredQuerySpans, [{ startLine: 11, endLine: 11 }]);
});

test("accepts an added content hunk and a later update for an added target", () => {
  const added = target({
    changeKind: "added",
    relevantHunks: [hunk({ operation: "add", oldPath: null, newPath: PATH })],
    targetSnapshot: { ...target().targetSnapshot, changeKind: "added" },
  });
  assert.equal(prove(added, change({ changeType: "add", payloadKind: "content", matchSide: "content", hunkRanges: [] }), patchHunk({ matchSide: "content", oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 })).status, "exact");
  assert.equal(prove(added, change(), patchHunk()).status, "exact");
});

test("requires every queried line to be inside the exact block and target hunk", () => {
  assert.equal(prove(target({ relevantHunks: [hunk({ queriedSpans: [{ startLine: 20, endLine: 20 }] })] })).status, "insufficient");
  assert.equal(prove(target({ relevantHunks: [hunk({ newStart: 50 })] }), change(), patchHunk()).status, "insufficient");
});

test("rejects path, operation, side, and hunk mismatches before fingerprint proof", () => {
  assert.equal(prove(target({ targetPath: "src/other.ts" })).status, "insufficient");
  assert.equal(prove(target(), change({ path: "src/other.ts" })).status, "insufficient");
  assert.equal(prove(target(), change({ changeType: "delete", payloadKind: "content", matchSide: "deleted" }), patchHunk({ matchSide: "content" })).status, "insufficient");
  assert.equal(prove(target(), change({ changeType: "add", payloadKind: "content", matchSide: "content" }), patchHunk()).status, "insufficient");
  assert.equal(prove(target(), change(), patchHunk({ newStart: 50 })).status, "insufficient");
});

test("rejects repeated alignments, weak distinctive material, and exact text changes", () => {
  const repeated = hunk({
    currentLineFingerprints: ["same", "line-a", "same", "line-b"],
    currentDistinctiveLineFingerprints: ["line-a", "line-b"],
    currentLineAlphanumericCounts: [1, 20, 1, 20],
    newLines: 4,
    queriedSpans: [{ startLine: 10, endLine: 13 }],
    addedLineFingerprints: ["same", "line-a", "same", "line-b"],
    distinctiveAddedLineFingerprints: ["line-a", "line-b"],
  });
  assert.equal(prove(target({ relevantHunks: [repeated], queriedSpans: repeated.queriedSpans }), change({ matchLineFingerprints: repeated.currentLineFingerprints }), patchHunk({ orderedLineFingerprints: ["same", "line-a"], lineCount: 2 })).status, "insufficient");
  assert.equal(prove(target({ relevantHunks: [hunk({ currentDistinctiveLineFingerprints: ["line-a"], distinctiveAddedLineFingerprints: ["line-a"] })] })).status, "insufficient");
  assert.equal(prove(target({ relevantHunks: [hunk({ currentLineAlphanumericCounts: [10, 10, 10] })] })).status, "insufficient");
  assert.equal(prove(target(), change(), patchHunk({ orderedLineFingerprints: ["line-a", "line-X", "line-c"] })).status, "insufficient");
});

test("fails closed for incomplete target, patch, and fingerprint coverage", () => {
  assert.equal(prove(target({ relevantHunks: [hunk({ complete: false as true })] })).status, "unavailable");
  assert.equal(prove(target(), change({ payloadRecovered: false })).status, "unavailable");
  assert.equal(prove(target(), change(), patchHunk({ truncated: true })).status, "unavailable");
});

test("enforces the 32-line exact proof bound", () => {
  const fingerprints = Array.from({ length: 33 }, (_value, index) => `line-${index}`);
  const longHunk = hunk({
    newLines: 33,
    queriedSpans: [{ startLine: 10, endLine: 42 }],
    currentLineFingerprints: fingerprints,
    currentDistinctiveLineFingerprints: fingerprints,
    currentLineAlphanumericCounts: fingerprints.map(() => 2),
    addedLineFingerprints: fingerprints,
    distinctiveAddedLineFingerprints: fingerprints,
  });
  assert.equal(prove(target({ relevantHunks: [longHunk], queriedSpans: longHunk.queriedSpans }), change(), patchHunk({ orderedLineFingerprints: fingerprints, lineCount: 33 })).status, "insufficient");
});
