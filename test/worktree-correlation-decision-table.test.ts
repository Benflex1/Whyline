import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentEvidence,
  AgentEvidenceBundle,
  AgentPatchChange,
  AgentPatchHunkEvidence,
  AgentSessionSummary,
} from "../src/agents/agent-history-source.js";
import { correlateWorktree } from "../src/correlation/correlate-worktree.js";
import type {
  CorrelationCandidateInput,
  CorrelationCoverage,
  WorktreeCorrelationHunk,
  WorktreeCorrelationTarget,
} from "../src/correlation/model.js";
import { scoreWorktreeCandidate } from "../src/correlation/score-worktree-candidate.js";

const targetPath = "src/target.ts";
const lineA = "const worktreeCorrelationAnchorAlpha = \"alpha-value\";";
const lineB = "const worktreeCorrelationAnchorBeta = \"beta-value\";";

function session(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    ref: { adapterId: "synthetic", sourcePath: "/opaque/session", sourceKind: "active" },
    sessionId: "session-1",
    initialCwd: "/workspace/project",
    workingDirectories: ["/workspace/project"],
    isPartial: false,
    diagnostics: [],
    ...overrides,
  };
}

function worktreeHunk(overrides: Partial<WorktreeCorrelationHunk> = {}): WorktreeCorrelationHunk {
  return {
    oldPath: targetPath,
    newPath: targetPath,
    oldStart: 10,
    oldLines: 0,
    newStart: 10,
    newLines: 2,
    targetLineKind: "added",
    addedLineFingerprints: ["a", "b"],
    deletedLineFingerprints: [],
    distinctiveAddedLineFingerprints: ["a", "b"],
    distinctiveDeletedLineFingerprints: [],
    truncated: false,
    basis: "derived",
    operation: "update",
    queriedSpans: [{ startLine: 10, endLine: 11 }],
    currentLineFingerprints: ["a", "b"],
    currentDistinctiveLineFingerprints: ["a", "b"],
    currentLineAlphanumericCounts: [lineA.replace(/[^a-zA-Z0-9]/g, "").length, lineB.replace(/[^a-zA-Z0-9]/g, "").length],
    complete: true,
    ...overrides,
  };
}

function target(overrides: Partial<WorktreeCorrelationTarget> = {}): WorktreeCorrelationTarget {
  const hunk = worktreeHunk();
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
    baseCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    targetPath,
    changeKind: "modified",
    staging: "unstaged",
    queriedSpans: [{ startLine: 10, endLine: 11 }],
    relevantHunks: [hunk],
    targetSnapshot: {
      baseCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repositoryPath: targetPath,
      changeKind: "modified",
      fileSnapshot: { size: 100, mtimeMs: 1, ino: 2, dev: 3, digest: "file" },
      evidenceDigest: "evidence",
    },
    ...overrides,
  };
}

function change(overrides: Partial<AgentPatchChange> = {}): AgentPatchChange {
  const hunk: AgentPatchHunkEvidence = {
    oldStart: 10,
    oldLines: 0,
    newStart: 10,
    newLines: 2,
    matchSide: "added",
    orderedLineFingerprints: ["a", "b"],
    distinctiveLineFingerprints: ["a", "b"],
    lineCount: 2,
    truncated: false,
  };
  return {
    path: targetPath,
    changeType: "update",
    payloadKind: "unified-diff",
    payloadRecovered: true,
    payloadFingerprint: "payload",
    payloadTruncated: false,
    addedLineFingerprints: ["a", "b"],
    matchLineFingerprints: ["a", "b"],
    distinctiveLineFingerprints: ["a", "b"],
    matchSide: "added",
    hunkRanges: [{ oldStart: 10, oldLines: 0, newStart: 10, newLines: 2 }],
    lineCount: 2,
    worktreeHunks: [hunk],
    ...overrides,
  };
}

function evidence(overrides: Partial<AgentEvidence> = {}): AgentEvidence {
  const current = change();
  return {
    id: "evidence-1",
    kind: "patch-result",
    cwd: "/workspace/project",
    worktreeIdentity: "exact-current-worktree",
    paths: [targetPath],
    operation: "patch",
    callId: "call-1",
    resultRecorded: true,
    reportedSuccess: true,
    patch: { callId: "call-1", reportedSuccess: true, changes: [current] },
    commitIds: [],
    extraction: "structured",
    sourceRecord: 10,
    ...overrides,
  };
}

function input(overrides: Partial<CorrelationCandidateInput> = {}): CorrelationCandidateInput {
  const value = evidence();
  const bundle: AgentEvidenceBundle = {
    session: session(),
    evidence: [value],
    unknownRecordCount: 0,
    diagnostics: [],
  };
  return {
    session: bundle.session,
    evidence: bundle,
    repositoryMatch: "current-worktree",
    eligible: true,
    references: [],
    coverageLimitations: [],
    ...overrides,
  };
}

function coverage(overrides: Partial<CorrelationCoverage> = {}): CorrelationCoverage {
  return {
    status: "complete",
    discoveredRefs: 1,
    usableSummaryRefs: 1,
    incompatibleRefs: 0,
    provenNotStrongRefs: 0,
    potentiallyStrongRefs: 1,
    fullyProjectedRefs: 1,
    omittedPotentiallyStrongRefs: 0,
    limitations: [],
    ...overrides,
  };
}

test("a complete exact current-worktree patch is strong and matches", () => {
  const candidate = scoreWorktreeCandidate(target(), input());
  assert.equal(candidate.band, "strong");
  assert.ok(candidate.signals.some((value) => value.kind === "structured-patch-overlap"));
  const result = correlateWorktree(target(), [input()], coverage());
  assert.equal(result.status, "matched");
  assert.equal(result.selected?.band, "strong");
});

test("a complete larger patch hunk can match a bounded exact proof block", () => {
  const trailingLines = Array.from({ length: 38 }, (_value, index) => `trailing-line-${index}`);
  const value = input({
    evidence: {
      ...input().evidence!,
      evidence: [evidence({
        patch: {
          ...evidence().patch!,
          changes: [change({
            worktreeHunks: [{
              ...change().worktreeHunks![0]!,
              newLines: 40,
              orderedLineFingerprints: ["a", "b", ...trailingLines],
              distinctiveLineFingerprints: ["a", "b", ...trailingLines],
              lineCount: 40,
            }],
          })],
        },
      })],
    },
  });
  const candidate = scoreWorktreeCandidate(target(), value);
  assert.equal(candidate.band, "strong");
  const result = correlateWorktree(target(), [value], coverage());
  assert.equal(result.status, "matched");
  assert.equal(result.selected?.band, "strong");
});

test("movedFrom is ignored when the current path evidence is otherwise complete", () => {
  const base = evidence();
  const value = input({
    evidence: {
      ...input().evidence!,
      evidence: [{
        ...base,
        patch: { ...base.patch!, changes: [change({ movedFrom: "src/old-target.ts" })] },
      }],
    },
  });
  assert.equal(scoreWorktreeCandidate(target(), value).band, "strong");
});

test("one distinctive line is plausible but never strong", () => {
  const base = evidence();
  const value = input({
    evidence: {
      ...input().evidence!,
      evidence: [{
        ...base,
        patch: {
          ...base.patch!,
          changes: [change({
            worktreeHunks: [{
              ...change().worktreeHunks![0]!,
              distinctiveLineFingerprints: ["a"],
            }],
          })],
        },
      }],
    },
  });
  const valueTarget = target({
    relevantHunks: [worktreeHunk({ currentDistinctiveLineFingerprints: ["a"] })],
  });
  const candidate = scoreWorktreeCandidate(valueTarget, value);
  assert.equal(candidate.band, "plausible");
  assert.equal(correlateWorktree(valueTarget, [value], coverage()).status, "none");
});

test("linked identity and candidate-level compatibility cannot qualify", () => {
  const value = input({
    evidence: {
      ...input().evidence!,
      evidence: [evidence({ worktreeIdentity: "linked-worktree" })],
    },
  });
  assert.equal(scoreWorktreeCandidate(target(), value).band, "weak");
  assert.equal(scoreWorktreeCandidate(target(), input({
    evidence: {
      ...input().evidence!,
      evidence: [evidence({ worktreeIdentity: undefined })],
    },
  })).band, "weak");
});

test("two strong worktree candidates remain ambiguous", () => {
  const result = correlateWorktree(target(), [input(), input({
    session: session({ sessionId: "session-2" }),
  })], coverage({ discoveredRefs: 2, usableSummaryRefs: 2, potentiallyStrongRefs: 2, fullyProjectedRefs: 2 }));
  assert.equal(result.status, "ambiguous");
  assert.equal(result.selected, undefined);
});

test("a plausible worktree candidate remains none with an alternative", () => {
  const value = input({
    evidence: {
      ...input().evidence!,
      evidence: [evidence({
        id: "path-only",
        patch: undefined,
        resultRecorded: false,
        reportedSuccess: undefined,
      })],
    },
  });
  const result = correlateWorktree(target(), [value], coverage());
  assert.equal(result.status, "none");
  assert.equal(result.alternatives.length, 0);
});
