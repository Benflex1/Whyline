import assert from "node:assert/strict";
import test from "node:test";

import { buildCorrelationTarget } from "../src/provenance/build-correlation-target.js";
import type {
  GitProvenance,
  RepositoryContext,
  ResolvedCodeLocation,
} from "../src/provenance/model.js";

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
  const hunk = target.relevantHunks[0];
  assert.ok(hunk !== undefined);
  assert.equal(hunk.addedLineFingerprints.length, 128);
  assert.equal(hunk.truncated, true);
  assert.equal("raw" in hunk, false);
});
