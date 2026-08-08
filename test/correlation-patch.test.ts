import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPatchChange } from "../src/agents/agent-history-source.js";
import type { CorrelationHunk, CorrelationTarget } from "../src/correlation/model.js";
import {
  comparePatchChangeToHunks,
  hasCompetingStructuredDivergence,
} from "../src/correlation/patch-overlap.js";

const targetPaths = {
  current: "src/current.ts",
  blamed: "src/original.ts",
};

function hunk(overrides: Partial<CorrelationHunk> = {}): CorrelationHunk {
  return {
    oldPath: targetPaths.blamed,
    newPath: targetPaths.current,
    oldStart: 10,
    oldLines: 2,
    newStart: 20,
    newLines: 4,
    targetLineKind: "added",
    addedLineFingerprints: ["added-one", "added-two", "added-boilerplate"],
    deletedLineFingerprints: ["deleted-one", "deleted-two"],
    distinctiveAddedLineFingerprints: ["added-one", "added-two"],
    distinctiveDeletedLineFingerprints: ["deleted-one", "deleted-two"],
    truncated: false,
    ...overrides,
  };
}

function target(overrides: Partial<CorrelationTarget> = {}): CorrelationTarget {
  return {
    repository: {
      worktreeRoot: "/workspace/project",
      commonGitDir: "/workspace/project/.git",
      objectFormat: "sha1",
      worktrees: [{
        path: "/workspace/project",
        commonGitDir: "/workspace/project/.git",
      }],
    },
    targetPath: targetPaths.current,
    blamedPath: targetPaths.blamed,
    commit: {
      id: "0123456789abcdef0123456789abcdef01234567",
      authoredAt: "2026-08-07T00:00:00.000Z",
      committedAt: "2026-08-07T00:00:00.000Z",
    },
    selectedParentId: "fedcba9876543210fedcba9876543210fedcba98",
    changedPaths: [{ oldPath: targetPaths.blamed, newPath: targetPaths.current }],
    relevantHunks: [hunk()],
    ...overrides,
  };
}

function change(overrides: Partial<AgentPatchChange> = {}): AgentPatchChange {
  return {
    path: targetPaths.current,
    changeType: "update",
    payloadKind: "unified-diff",
    payloadRecovered: true,
    payloadFingerprint: "payload",
    payloadTruncated: false,
    addedLineFingerprints: ["added-one", "added-two"],
    matchLineFingerprints: ["added-one", "added-two"],
    distinctiveLineFingerprints: ["added-one", "added-two"],
    matchSide: "added",
    hunkRanges: [{ oldStart: 10, oldLines: 2, newStart: 20, newLines: 4 }],
    lineCount: 4,
    ...overrides,
  };
}

function assertDirect(overlap: ReturnType<typeof comparePatchChangeToHunks>): void {
  assert.equal(overlap.direct, true);
  assert.equal(overlap.reason, "direct-overlap");
  assert.equal(overlap.distinctiveIntersectionCount, 2);
}

test("matches update, add, and delete changes only on operation-compatible sides", () => {
  const cases: readonly [string, AgentPatchChange][] = [
    ["update", change()],
    ["add", change({
      changeType: "add",
      payloadKind: "content",
      addedLineFingerprints: ["added-one", "added-two"],
      matchLineFingerprints: ["added-one", "added-two"],
      matchSide: "content",
      hunkRanges: [],
    })],
    ["delete", change({
      path: targetPaths.blamed,
      changeType: "delete",
      payloadKind: "content",
      addedLineFingerprints: [],
      matchLineFingerprints: ["deleted-one", "deleted-two"],
      distinctiveLineFingerprints: ["deleted-one", "deleted-two"],
      matchSide: "deleted",
      hunkRanges: [],
    })],
  ];

  for (const [name, patchChange] of cases) {
    const overlap = comparePatchChangeToHunks(target(), patchChange);
    assertDirect(overlap);
    assert.equal(overlap.operationCompatible, true, name);
  }
});

test("requires two distinctive fingerprints and rejects boilerplate-only overlap", () => {
  const oneLine = comparePatchChangeToHunks(target(), change({
    distinctiveLineFingerprints: ["added-one"],
  }));
  assert.equal(oneLine.direct, false);
  assert.equal(oneLine.distinctiveIntersectionCount, 1);
  assert.equal(oneLine.reason, "insufficient-distinctive-overlap");

  const boilerplate = comparePatchChangeToHunks(target(), change({
    matchLineFingerprints: ["added-boilerplate"],
    distinctiveLineFingerprints: [],
  }));
  assert.equal(boilerplate.direct, false);
  assert.equal(boilerplate.distinctiveIntersectionCount, 0);
  assert.equal(boilerplate.reason, "insufficient-distinctive-overlap");
});

test("accepts current, blamed, and rename-related paths only", () => {
  for (const path of [targetPaths.current, targetPaths.blamed, "src/renamed.ts"]) {
    const pathTarget = target({
      targetPath: targetPaths.current,
      blamedPath: targetPaths.blamed,
      changedPaths: [{ oldPath: "src/renamed.ts", newPath: targetPaths.current }],
      relevantHunks: [hunk({ oldPath: "src/renamed.ts" })],
    });
    const overlap = comparePatchChangeToHunks(pathTarget, change({ path }));
    assertDirect(overlap);
    assert.equal(overlap.pathMatched, true, path);
  }

  const unrelated = comparePatchChangeToHunks(target(), change({ path: "src/other.ts" }));
  assert.equal(unrelated.direct, false);
  assert.equal(unrelated.pathMatched, false);
  assert.equal(unrelated.reason, "path-mismatch");
});

test("does not accept unrelated changed paths for direct overlap", () => {
  const unrelatedPath = "src/unrelated.ts";
  const unrelatedTarget = target({
    changedPaths: [{ oldPath: unrelatedPath, newPath: "src/unrelated-renamed.ts" }],
    relevantHunks: [hunk({
      oldPath: unrelatedPath,
      newPath: "src/unrelated-renamed.ts",
    })],
  });

  const overlap = comparePatchChangeToHunks(
    unrelatedTarget,
    change({ path: unrelatedPath }),
  );
  assert.equal(overlap.direct, false);
  assert.equal(overlap.pathMatched, false);
  assert.equal(overlap.reason, "path-mismatch");
});

test("does not accept unrelated changed paths for divergence", () => {
  const unrelatedPath = "src/unrelated.ts";
  const unrelatedTarget = target({
    changedPaths: [{ oldPath: unrelatedPath, newPath: "src/unrelated-renamed.ts" }],
    relevantHunks: [hunk({
      oldPath: unrelatedPath,
      newPath: "src/unrelated-renamed.ts",
    })],
  });
  const competing = change({
    path: unrelatedPath,
    distinctiveLineFingerprints: ["unrelated-one", "unrelated-two"],
    matchLineFingerprints: ["unrelated-one", "unrelated-two"],
  });

  assert.equal(hasCompetingStructuredDivergence(unrelatedTarget, [competing]), false);
});

test("does not treat pathless Git hunks as overlap or divergence", () => {
  const pathlessTarget = target({
    relevantHunks: [hunk({ oldPath: null, newPath: null })],
  });

  const matching = comparePatchChangeToHunks(pathlessTarget, change());
  assert.equal(matching.direct, false);
  assert.equal(matching.pathMatched, true);
  assert.equal(matching.reason, "no-relevant-hunk");

  const competing = change({
    distinctiveLineFingerprints: ["unrelated-one", "unrelated-two"],
    matchLineFingerprints: ["unrelated-one", "unrelated-two"],
  });
  assert.equal(hasCompetingStructuredDivergence(pathlessTarget, [competing]), false);
});

test("surfaces unknown coverage for a truncated pathless Git hunk", () => {
  const truncatedPathlessTarget = target({
    relevantHunks: [hunk({ oldPath: null, newPath: null, truncated: true })],
  });
  const competing = change({
    distinctiveLineFingerprints: ["unrelated-one", "unrelated-two"],
    matchLineFingerprints: ["unrelated-one", "unrelated-two"],
  });

  const overlap = comparePatchChangeToHunks(truncatedPathlessTarget, competing);
  assert.equal(overlap.direct, false);
  assert.equal(overlap.pathMatched, true);
  assert.equal(overlap.unknown, true);
  assert.equal(overlap.reason, "truncated-git-hunk");
  assert.equal(
    hasCompetingStructuredDivergence(truncatedPathlessTarget, [competing]),
    false,
  );
});

test("rejects unsupported combinations and truncated payloads", () => {
  const unsupported = [
    change({ payloadKind: "content", matchSide: "content", hunkRanges: [] }),
    change({ changeType: "add", payloadKind: "unified-diff" }),
    change({ changeType: "delete", payloadKind: "unified-diff", matchSide: "deleted" }),
    change({ changeType: "unknown", matchSide: "content", hunkRanges: [] }),
  ];
  for (const patchChange of unsupported) {
    const overlap = comparePatchChangeToHunks(target(), patchChange);
    assert.equal(overlap.direct, false);
    assert.equal(overlap.operationCompatible, false);
    assert.equal(overlap.reason, "unsupported-combination");
  }

  const truncated = comparePatchChangeToHunks(target(), change({ payloadTruncated: true }));
  assert.equal(truncated.direct, false);
  assert.equal(truncated.unknown, true);
  assert.equal(truncated.reason, "truncated-patch-payload");
});

test("uses update hunk locality before declaring direct overlap", () => {
  const outside = comparePatchChangeToHunks(target(), change({
    hunkRanges: [{ oldStart: 100, oldLines: 2, newStart: 100, newLines: 4 }],
  }));
  assert.equal(outside.direct, false);
  assert.equal(outside.pathMatched, true);
  assert.equal(outside.hunkLocal, false);
  assert.equal(outside.reason, "outside-hunk");
});

test("does not infer divergence from non-overlapping content-only add/delete payloads", () => {
  const add = change({
    changeType: "add",
    payloadKind: "content",
    addedLineFingerprints: ["unrelated-one", "unrelated-two"],
    matchLineFingerprints: ["unrelated-one", "unrelated-two"],
    distinctiveLineFingerprints: ["unrelated-one", "unrelated-two"],
    matchSide: "content",
    hunkRanges: [],
  });
  const deleted = change({
    path: targetPaths.blamed,
    changeType: "delete",
    payloadKind: "content",
    addedLineFingerprints: [],
    matchLineFingerprints: ["unrelated-one", "unrelated-two"],
    distinctiveLineFingerprints: ["unrelated-one", "unrelated-two"],
    matchSide: "deleted",
    hunkRanges: [],
  });
  assert.equal(hasCompetingStructuredDivergence(target(), [add, deleted]), false);
});

test("tracks update divergence by supplied record order and hunk locality", () => {
  const competing = change({
    distinctiveLineFingerprints: ["unrelated-one", "unrelated-two"],
    matchLineFingerprints: ["unrelated-one", "unrelated-two"],
  });
  const matching = change();

  assert.equal(hasCompetingStructuredDivergence(target(), [competing, matching]), false);
  assert.equal(hasCompetingStructuredDivergence(target(), [matching, competing]), true);
  assert.equal(
    hasCompetingStructuredDivergence(target(), [change({
      hunkRanges: [{ oldStart: 100, oldLines: 2, newStart: 100, newLines: 4 }],
      distinctiveLineFingerprints: ["unrelated-one", "unrelated-two"],
      matchLineFingerprints: ["unrelated-one", "unrelated-two"],
    })]),
    false,
  );
});

test("suppresses absence-based divergence when a relevant Git hunk is truncated", () => {
  const competing = change({
    distinctiveLineFingerprints: ["unrelated-one", "unrelated-two"],
    matchLineFingerprints: ["unrelated-one", "unrelated-two"],
  });
  const result = comparePatchChangeToHunks(
    target({ relevantHunks: [hunk({ truncated: true })] }),
    competing,
  );
  assert.equal(result.direct, false);
  assert.equal(result.unknown, true);
  assert.equal(result.reason, "truncated-git-hunk");
  assert.equal(hasCompetingStructuredDivergence(target({ relevantHunks: [hunk({ truncated: true })] }), [competing]), false);
});
