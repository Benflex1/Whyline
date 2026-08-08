import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentEvidence,
  AgentEvidenceBundle,
  AgentPatchChange,
  AgentSessionSummary,
} from "../src/agents/agent-history-source.js";
import type {
  CorrelationCandidate,
  CorrelationCandidateInput,
  CorrelationCoverage,
  CorrelationHunk,
  CorrelationLimitation,
  CorrelationTarget,
  ResolvedCommitReference,
} from "../src/correlation/model.js";
import { buildCandidateInput } from "../src/correlation/build-candidates.js";
import { correlate } from "../src/correlation/correlate.js";
import { scoreCandidate } from "../src/correlation/score-candidate.js";

const targetPath = "src/target.ts";
const otherPath = "src/other.ts";
const sessionHead = "0123456789abcdef0123456789abcdef01234567";
const unrelatedCommit = "fedcba9876543210fedcba9876543210fedcba98";

function session(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    ref: { adapterId: "synthetic", sourcePath: "/opaque/session", sourceKind: "active" },
    sessionId: "session-1",
    startedAt: "2026-08-07T00:00:00.000Z",
    observedThroughAt: "2026-08-07T01:00:00.000Z",
    initialCwd: "/workspace/project",
    workingDirectories: ["/workspace/project"],
    transcriptGit: {
      commitHash: sessionHead,
      referenceKind: "session-head",
    },
    isPartial: false,
    diagnostics: [],
    ...overrides,
  };
}

function hunk(overrides: Partial<CorrelationHunk> = {}): CorrelationHunk {
  return {
    oldPath: targetPath,
    newPath: targetPath,
    oldStart: 10,
    oldLines: 2,
    newStart: 10,
    newLines: 4,
    targetLineKind: "added",
    addedLineFingerprints: ["line-a", "line-b"],
    deletedLineFingerprints: ["old-a", "old-b"],
    distinctiveAddedLineFingerprints: ["line-a", "line-b"],
    distinctiveDeletedLineFingerprints: ["old-a", "old-b"],
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
      worktrees: [{ path: "/workspace/project", commonGitDir: "/workspace/project/.git" }],
    },
    targetPath,
    blamedPath: targetPath,
    commit: {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      authoredAt: "2026-08-07T00:00:00.000Z",
      committedAt: "2026-08-07T00:00:00.000Z",
    },
    selectedParentId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    changedPaths: [{ oldPath: targetPath, newPath: targetPath }],
    relevantHunks: [hunk()],
    ...overrides,
  };
}

function patchChange(overrides: Partial<AgentPatchChange> = {}): AgentPatchChange {
  return {
    path: targetPath,
    changeType: "update",
    payloadKind: "unified-diff",
    payloadRecovered: true,
    payloadFingerprint: "opaque-payload",
    payloadTruncated: false,
    addedLineFingerprints: ["line-a", "line-b"],
    matchLineFingerprints: ["line-a", "line-b"],
    distinctiveLineFingerprints: ["line-a", "line-b"],
    matchSide: "added",
    hunkRanges: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 4 }],
    lineCount: 4,
    ...overrides,
  };
}

function patchEvidence(
  changes: readonly AgentPatchChange[] = [patchChange()],
  overrides: Partial<AgentEvidence> = {},
): AgentEvidence {
  return {
    id: "evidence-1",
    kind: "patch-result",
    occurredAt: "2026-08-07T00:30:00.000Z",
    paths: [...new Set(changes.map((change) => change.path))],
    operation: "patch",
    callId: "call-1",
    resultRecorded: true,
    reportedSuccess: true,
    patch: {
      callId: "call-1",
      reportedSuccess: true,
      changes,
    },
    commitIds: [],
    extraction: "structured",
    sourceRecord: 10,
    ...overrides,
  };
}

function evidenceBundle(
  evidence: readonly AgentEvidence[] = [patchEvidence()],
  overrides: Partial<AgentEvidenceBundle> = {},
): AgentEvidenceBundle {
  return {
    session: session(),
    evidence,
    unknownRecordCount: 0,
    diagnostics: [],
    ...overrides,
  };
}

function reference(
  overrides: Partial<ResolvedCommitReference> = {},
): ResolvedCommitReference {
  return {
    kind: "session-head",
    reference: sessionHead,
    resolution: "target",
    ...overrides,
  };
}

function input(overrides: Partial<CorrelationCandidateInput> = {}): CorrelationCandidateInput {
  return {
    session: session(),
    evidence: evidenceBundle(),
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
    summaryEligibleRefs: 1,
    fullyExtractedRefs: 1,
    omittedEligibleRefs: 0,
    limitations: [],
    ...overrides,
  };
}

function scored(overrides: Partial<CorrelationCandidateInput> = {}): CorrelationCandidate {
  return scoreCandidate(target(), input(overrides));
}

test("eligibility table excludes incompatible and unanchored unknown candidates", () => {
  const cases: readonly {
    readonly name: string;
    readonly candidate: CorrelationCandidateInput;
    readonly eligible: boolean;
    readonly limitation?: string;
  }[] = [
    {
      name: "known incompatible common Git directory",
      candidate: input({ repositoryMatch: "incompatible" }),
      eligible: false,
    },
    {
      name: "deleted cwd without safe anchor",
      candidate: input({ repositoryMatch: "unknown", evidence: null }),
      eligible: false,
      limitation: "unresolved-repository-candidate",
    },
    {
      name: "deleted cwd with resolved session-head anchor",
      candidate: input({ repositoryMatch: "unknown", evidence: null, references: [reference()] }),
      eligible: true,
    },
    {
      name: "unsupported summary",
      candidate: input({ session: session({ sessionId: null }) }),
      eligible: false,
      limitation: "unsupported-summary",
    },
  ];

  for (const row of cases) {
    const built = buildCandidateInput({
      session: row.candidate.session,
      evidence: row.candidate.evidence,
      repositoryMatch: row.candidate.repositoryMatch,
      references: row.candidate.references,
      coverageLimitations: row.candidate.coverageLimitations,
    });
    assert.equal(built.eligible, row.eligible, row.name);
    if (row.limitation !== undefined) {
      assert.equal(
        built.coverageLimitations.some((limitation) => limitation.kind === row.limitation),
        true,
        row.name,
      );
    }
  }
});

test("candidate decision table assigns conservative bands and typed signals", () => {
  const cases: readonly {
    readonly name: string;
    readonly candidate: Partial<CorrelationCandidateInput>;
    readonly band: CorrelationCandidate["band"];
    readonly requiredSignals: readonly string[];
    readonly contradiction: boolean;
  }[] = [
    {
      name: "current repository plus session-head without patch",
      candidate: { evidence: null, references: [reference()] },
      band: "weak",
      requiredSignals: ["exact-current-worktree", "session-head-target-reference"],
      contradiction: false,
    },
    {
      name: "current repository plus distinctive structured overlap",
      candidate: { references: [] },
      band: "strong",
      requiredSignals: ["exact-current-worktree", "structured-patch-overlap", "structured-patch-target-path", "changed-path-overlap"],
      contradiction: false,
    },
    {
      name: "stale session-head plus current patch overlap",
      candidate: { references: [reference({ resolution: "other", reference: unrelatedCommit })] },
      band: "strong",
      requiredSignals: ["structured-patch-overlap", "historical-commit-reference"],
      contradiction: false,
    },
    {
      name: "unknown cwd plus resolved session-head and patch",
      candidate: { repositoryMatch: "unknown", references: [reference()] },
      band: "strong",
      requiredSignals: ["session-head-target-reference", "structured-patch-overlap"],
      contradiction: false,
    },
    {
      name: "unknown repository plus exact SHA only",
      candidate: { repositoryMatch: "unknown", evidence: null, references: [reference()] },
      band: "weak",
      requiredSignals: ["session-head-target-reference"],
      contradiction: false,
    },
    {
      name: "unknown repository plus session-head and path evidence",
      candidate: {
        repositoryMatch: "unknown",
        references: [reference()],
        evidence: evidenceBundle([patchEvidence([patchChange({ distinctiveLineFingerprints: ["line-a"], matchLineFingerprints: ["line-a"] })])]),
      },
      band: "weak",
      requiredSignals: ["session-head-target-reference", "structured-patch-target-path"],
      contradiction: false,
    },
    {
      name: "filename and time only",
      candidate: {
        evidence: evidenceBundle([{
          id: "evidence-activity",
          kind: "command-attempt",
          occurredAt: "2026-08-07T00:20:00.000Z",
          paths: [targetPath],
          operation: "command",
          commitIds: [],
          extraction: "structured",
          sourceRecord: 2,
        }]),
      },
      band: "weak",
      requiredSignals: ["exact-current-worktree", "temporal-proximity"],
      contradiction: false,
    },
    {
      name: "repository plus changed path without recovered patch",
      candidate: {
        evidence: evidenceBundle([{
          id: "evidence-path",
          kind: "patch-result",
          paths: [targetPath],
          operation: "patch",
          resultRecorded: true,
          reportedSuccess: false,
          patch: { callId: "call-path", reportedSuccess: false, changes: [patchChange({ payloadRecovered: false })] },
          commitIds: [],
          extraction: "structured",
          sourceRecord: 4,
        }]),
      },
      band: "weak",
      requiredSignals: ["structured-patch-attempt-target-path"],
      contradiction: false,
    },
    {
      name: "known mismatch regardless of evidence",
      candidate: { repositoryMatch: "incompatible" },
      band: "weak",
      requiredSignals: [],
      contradiction: false,
    },
    {
      name: "only active divergence",
      candidate: {
        evidence: evidenceBundle([
          patchEvidence([patchChange({ distinctiveLineFingerprints: ["different-a", "different-b"], matchLineFingerprints: ["different-a", "different-b"] })], { id: "evidence-divergence", sourceRecord: 20 }),
        ]),
      },
      band: "plausible",
      requiredSignals: ["structured-content-divergence"],
      contradiction: true,
    },
  ];

  for (const row of cases) {
    const candidate = scored(row.candidate);
    assert.equal(candidate.band, row.band, row.name);
    for (const kind of row.requiredSignals) {
      assert.equal(candidate.signals.some((signal) => signal.kind === kind)
        || candidate.contradictions.some((signal) => signal.kind === kind), true, `${row.name}: ${kind}`);
    }
    assert.equal(candidate.contradictions.length > 0, row.contradiction, row.name);
    assert.equal(candidate.signals.some((signal) => "prompt" in signal || "command" in signal || "output" in signal), false, row.name);
  }
});

test("changed-path overlap is independent from target-path overlap", () => {
  const changedFileOnly = scoreCandidate(
    target({
      changedPaths: [
        { oldPath: targetPath, newPath: targetPath },
        { oldPath: otherPath, newPath: otherPath },
      ],
    }),
    input({
      evidence: evidenceBundle([patchEvidence([patchChange({ path: otherPath })])]),
    }),
  );

  assert.equal(changedFileOnly.signals.some((signal) => signal.kind === "changed-path-overlap"), true);
  assert.equal(changedFileOnly.signals.some((signal) => signal.kind === "structured-patch-target-path"), false);
  assert.equal(changedFileOnly.band, "plausible");
});

test("ambiguous and unresolved commit references do not become historical context", () => {
  for (const resolution of ["ambiguous", "unresolved"] as const) {
    const candidate = scored({
      evidence: null,
      references: [reference({ resolution })],
    });

    assert.equal(candidate.signals.some((signal) => signal.kind === "historical-commit-reference"), false, resolution);
  }
});

test("chronology table suppresses superseded divergence and preserves later contradiction", () => {
  const divergent = patchChange({
    distinctiveLineFingerprints: ["different-a", "different-b"],
    matchLineFingerprints: ["different-a", "different-b"],
  });
  const matching = patchChange();
  const cases: readonly {
    readonly name: string;
    readonly changes: readonly AgentPatchChange[];
    readonly contradiction: boolean;
  }[] = [
    { name: "earlier divergence then later match", changes: [divergent, matching], contradiction: false },
    { name: "earlier match then later divergence", changes: [matching, divergent], contradiction: true },
    { name: "unrelated same-file hunk", changes: [patchChange({ hunkRanges: [{ oldStart: 100, oldLines: 2, newStart: 100, newLines: 2 }] })], contradiction: false },
  ];

  for (const row of cases) {
    const candidate = scored({
      evidence: evidenceBundle([patchEvidence(row.changes)]),
    });
    assert.equal(candidate.contradictions.some((signal) => signal.kind === "structured-content-divergence"), row.contradiction, row.name);
  }
});

test("coverage table keeps safe pre-match compaction informational and later loss material", () => {
  const beforeMatch = scored({
    evidence: evidenceBundle([patchEvidence([patchChange()], { sourceRecord: 10 })], {
      diagnostics: [{ kind: "compacted-history", record: 5 }],
    }),
  });
  assert.equal(beforeMatch.coverage, "complete");
  assert.equal(beforeMatch.coverageLimitations.some((limitation) => limitation.kind === "material-compaction" && limitation.material), false);

  const afterMatch = scored({
    evidence: evidenceBundle([patchEvidence([patchChange()], { sourceRecord: 10 })], {
      diagnostics: [{ kind: "compacted-history", record: 20 }],
    }),
  });
  assert.equal(afterMatch.coverage, "limited");
  assert.equal(afterMatch.coverageLimitations.some((limitation) => limitation.kind === "material-compaction" && limitation.material), true);

  const changedDuringRead = scored({
    evidence: evidenceBundle([patchEvidence()], {
      diagnostics: [{ kind: "changed-during-read" }],
    }),
  });
  assert.equal(changedDuringRead.coverage, "limited");

  const unrecoveredSuccess = scored({
    evidence: evidenceBundle([patchEvidence([patchChange({ payloadRecovered: false })])]),
  });
  assert.equal(unrecoveredSuccess.band, "weak");
  assert.equal(unrecoveredSuccess.signals.some((signal) => signal.kind === "structured-patch-attempt-target-path"), true);
});

test("candidate material limitations are reflected in global coverage", () => {
  const cases: readonly {
    readonly name: string;
    readonly target: CorrelationTarget;
    readonly candidate: CorrelationCandidateInput;
    readonly limitation: CorrelationLimitation["kind"];
  }[] = [
    {
      name: "later compaction",
      target: target(),
      candidate: input({
        evidence: evidenceBundle([patchEvidence()], {
          diagnostics: [{ kind: "compacted-history", record: 20 }],
        }),
      }),
      limitation: "material-compaction",
    },
    {
      name: "truncated Git hunk",
      target: target({ relevantHunks: [hunk({ truncated: true })] }),
      candidate: input(),
      limitation: "truncated-git-hunk",
    },
  ];

  for (const row of cases) {
    const result = correlate(row.target, [row.candidate], coverage());
    assert.equal(result.status, "none", row.name);
    assert.equal(result.coverage.status, "limited", row.name);
    assert.equal(
      result.coverage.limitations.some((limitation) => limitation.kind === row.limitation && limitation.material),
      true,
      row.name,
    );
    assert.equal(
      result.alternatives[0]?.coverageLimitations.some((limitation) => limitation.kind === row.limitation && limitation.material),
      true,
      row.name,
    );
  }
});

test("operation and coverage table gates direct overlap and final selection", () => {
  const operationCases: readonly {
    readonly name: string;
    readonly change: AgentPatchChange;
    readonly band: CorrelationCandidate["band"];
  }[] = [
    { name: "update added lines", change: patchChange(), band: "strong" },
    { name: "add post-image", change: patchChange({ changeType: "add", payloadKind: "content", matchSide: "content", hunkRanges: [] }), band: "strong" },
    { name: "delete deleted lines", change: patchChange({ path: targetPath, changeType: "delete", payloadKind: "content", addedLineFingerprints: [], matchLineFingerprints: ["old-a", "old-b"], distinctiveLineFingerprints: ["old-a", "old-b"], matchSide: "deleted", hunkRanges: [] }), band: "strong" },
    { name: "boilerplate only", change: patchChange({ distinctiveLineFingerprints: [], matchLineFingerprints: ["return value;"] }), band: "plausible" },
    { name: "truncated payload", change: patchChange({ payloadTruncated: true }), band: "weak" },
  ];

  for (const row of operationCases) {
    const candidate = scored({ evidence: evidenceBundle([patchEvidence([row.change])]) });
    assert.equal(candidate.band, row.band, row.name);
  }

  const strong = input({ session: session({ sessionId: "strong" }) });
  const plausible = input({
    session: session({ sessionId: "plausible" }),
    evidence: evidenceBundle([{
      id: "evidence-plausible",
      kind: "patch-result",
      paths: [targetPath],
      operation: "patch",
      resultRecorded: true,
      reportedSuccess: true,
      patch: { callId: "call-plausible", reportedSuccess: true, changes: [patchChange({ distinctiveLineFingerprints: ["line-a"], matchLineFingerprints: ["line-a"] })] },
      commitIds: [],
      extraction: "structured",
      sourceRecord: 5,
    }]),
  });

  const finalCases: readonly {
    readonly name: string;
    readonly inputs: readonly CorrelationCandidateInput[];
    readonly coverage: CorrelationCoverage;
    readonly status: "matched" | "ambiguous" | "none" | "unavailable";
    readonly selected?: string;
  }[] = [
    { name: "one strong complete", inputs: [strong], coverage: coverage(), status: "matched", selected: "strong" },
    { name: "two strong", inputs: [strong, input({ session: session({ sessionId: "strong-2" }) })], coverage: coverage({ discoveredRefs: 2, summaryEligibleRefs: 2, fullyExtractedRefs: 2 }), status: "ambiguous" },
    { name: "strong plus plausible", inputs: [strong, plausible], coverage: coverage({ discoveredRefs: 2, summaryEligibleRefs: 2, fullyExtractedRefs: 2 }), status: "matched", selected: "strong" },
    { name: "two plausible", inputs: [plausible, input({ session: session({ sessionId: "plausible-2" }), evidence: plausible.evidence })], coverage: coverage({ discoveredRefs: 2, summaryEligibleRefs: 2, fullyExtractedRefs: 2 }), status: "none" },
    { name: "strong omitted candidate", inputs: [strong], coverage: coverage({ omittedEligibleRefs: 1, limitations: [{ kind: "candidate-cap", material: true, count: 1 }] }), status: "none" },
    { name: "truncated relevant Git hunk", inputs: [strong], coverage: coverage(), status: "none" },
    { name: "empty readable store", inputs: [], coverage: coverage({ discoveredRefs: 0, summaryEligibleRefs: 0, fullyExtractedRefs: 0, limitations: [{ kind: "empty-readable-store", material: false }] }), status: "none" },
    { name: "explicit unavailable source", inputs: [], coverage: coverage({ status: "unavailable", discoveredRefs: 0, summaryEligibleRefs: 0, fullyExtractedRefs: 0, limitations: [{ kind: "discovery-unavailable", material: true }] }), status: "unavailable" },
  ];

  for (const row of finalCases) {
    const result = correlate(
      row.name === "truncated relevant Git hunk" ? target({ relevantHunks: [hunk({ truncated: true })] }) : target(),
      row.inputs,
      row.coverage,
    );
    assert.equal(result.status, row.status, row.name);
    if (row.selected !== undefined) {
      assert.equal(result.selected?.session.sessionId, row.selected, row.name);
    } else {
      assert.equal(result.selected, undefined, row.name);
    }
  }
});

test("ineligible material limitations remain global coverage blockers", () => {
  const unresolved = buildCandidateInput({
    session: session({ sessionId: "unresolved" }),
    evidence: null,
    repositoryMatch: "unknown",
    references: [],
  });
  const unsupported = buildCandidateInput({
    session: session({ sessionId: null }),
    evidence: null,
    repositoryMatch: "incompatible",
    references: [],
  });
  const strong = input({ session: session({ sessionId: "strong" }) });

  const result = correlate(
    target(),
    [strong, unresolved, unsupported],
    coverage({ discoveredRefs: 3, summaryEligibleRefs: 1, fullyExtractedRefs: 1 }),
  );

  assert.equal(result.status, "none");
  assert.equal(result.coverage.status, "limited");
  assert.equal(result.coverage.limitations.some((limitation) => limitation.kind === "unresolved-repository-candidate"), true);
  assert.equal(result.coverage.limitations.some((limitation) => limitation.kind === "unsupported-summary"), true);
});
