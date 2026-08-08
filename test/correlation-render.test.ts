import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSessionSummary } from "../src/agents/agent-history-source.js";
import type {
  CorrelationCandidate,
  CorrelationResult,
} from "../src/correlation/model.js";
import { renderCorrelation } from "../src/cli/render-correlation.js";
import { renderText } from "../src/cli/render-text.js";
import type { WhylineReport } from "../src/provenance/model.js";

const sensitiveSummaryFields: AgentSessionSummary = {
  ref: {
    adapterId: "codex",
    sourcePath: "/absolute/transcripts/prompt-secret.jsonl",
    sourceKind: "active",
  },
  sessionId: "session-1234567890abcdef",
  initialCwd: "/absolute/worktree",
  workingDirectories: ["/absolute/worktree"],
  source: "https://example.test/private-repository",
  isPartial: false,
  diagnostics: [],
};

function candidate(
  sessionId: string,
  overrides: Partial<CorrelationCandidate> = {},
): CorrelationCandidate {
  return {
    session: {
      ...sensitiveSummaryFields,
      sessionId,
    },
    eligible: true,
    repositoryMatch: "current-worktree",
    score: 999,
    signals: [
      {
        kind: "exact-current-worktree",
        weight: 5,
        basis: "fact",
        evidenceIds: ["prompt-secret", "command=rm -rf /", "https://example.test/raw"],
      },
      {
        kind: "structured-patch-overlap",
        weight: 8,
        basis: "derived",
        evidenceIds: ["patch-source-line: const secret = true;"],
      },
      {
        kind: "structured-patch-target-path",
        weight: 4,
        basis: "derived",
        evidenceIds: [],
      },
    ],
    contradictions: [],
    band: "strong",
    coverage: "complete",
    coverageLimitations: [],
    ...overrides,
  };
}

function result(
  status: CorrelationResult["status"],
  overrides: Partial<CorrelationResult> = {},
): CorrelationResult {
  return {
    status,
    alternatives: [],
    coverage: {
      status: "complete",
      discoveredRefs: 1,
      summaryEligibleRefs: 1,
      fullyExtractedRefs: 1,
      omittedEligibleRefs: 0,
      limitations: [],
    },
    ...overrides,
  };
}

test("renders a matched result with bounded fixed evidence", () => {
  const output = renderCorrelation(result("matched", {
    selected: candidate("session-1234567890abcdef"),
  }));

  assert.equal(output, [
    "Codex evidence",
    "  Likely related Codex session: session-1234567890abcdef",
    "  Evidence: session repository matches the current worktree; structured patch content overlaps the attributed change; structured patch targets the attributed path",
    "  Coverage: complete",
  ].join("\n"));
  for (const secret of [
    "999",
    "prompt-secret",
    "const secret = true;",
    "rm -rf /",
    "https://example.test",
    "/absolute/transcripts/prompt-secret.jsonl",
    "/absolute/worktree",
  ]) {
    assert.equal(output.includes(secret), false, secret);
  }
});

test("bounds and allocates the selected and possible session IDs", () => {
  const longSessionId = "x".repeat(256);
  const matched = renderCorrelation(result("matched", {
    selected: candidate(longSessionId),
  }));
  const possible = renderCorrelation(result("none", {
    alternatives: [candidate(longSessionId, { band: "plausible" })],
  }));

  for (const output of [matched, possible]) {
    assert.equal(output.includes(longSessionId), false);
    const idLine = output.split("\n").find((line) => line.includes("session: "));
    assert.ok(idLine !== undefined);
    assert.equal(idLine.length <= 80, true);
  }
});

test("renders ambiguity without selecting a session and extends colliding IDs", () => {
  const output = renderCorrelation(result("ambiguous", {
    alternatives: [
      candidate("abcdef12-first-session"),
      candidate("abcdef12-second-session"),
    ],
  }));

  assert.equal(output, [
    "Codex evidence",
    "  Multiple strong candidates; no session selected",
    "  Candidates:",
    "    abcdef12-f…",
    "    abcdef12-s…",
    "  Coverage: complete",
  ].join("\n"));
  assert.equal(output.includes("Likely related Codex session"), false);
});

test("keeps distinct session IDs distinct after safe encoding", () => {
  const output = renderCorrelation(result("ambiguous", {
    alternatives: [candidate("a/b"), candidate("a?b")],
  }));

  assert.equal(output.includes("    a~002fb"), true);
  assert.equal(output.includes("    a~003fb"), true);
  assert.equal(output.includes("    a_b"), false);
});

test("does not claim a match for a plausible selected candidate", () => {
  const output = renderCorrelation(result("matched", {
    selected: candidate("plausible-selected", { band: "plausible" }),
  }));

  assert.equal(output.includes("Likely related Codex session"), false);
  assert.equal(output.includes("Possible related session: plausible-selected"), true);
  assert.equal(output.includes("Evidence is insufficient to claim a match."), true);
});

test("renders a lone plausible candidate as possible only", () => {
  const possible = candidate("possible-session", {
    band: "plausible",
    coverage: "limited",
    contradictions: [{
      kind: "structured-content-divergence",
      weight: -5,
      basis: "inferred",
      evidenceIds: [],
    }],
  });
  const output = renderCorrelation(result("none", {
    alternatives: [possible],
    coverage: {
      status: "limited",
      discoveredRefs: 2,
      summaryEligibleRefs: 2,
      fullyExtractedRefs: 1,
      omittedEligibleRefs: 1,
      limitations: [{ kind: "candidate-cap", material: true }],
    },
  }));

  assert.equal(output, [
    "Codex evidence",
    "  Possible related session: possible-session",
    "  Evidence: session repository matches the current worktree; structured patch content overlaps the attributed change; structured patch targets the attributed path; structured patch content diverges from the attributed change",
    "  Evidence is insufficient to claim a match.",
    "  Coverage: limited; some eligible sessions were omitted from bounded inspection",
  ].join("\n"));

  const retainedStrong = renderCorrelation(result("none", {
    alternatives: [candidate("retained-strong", { coverage: "limited" })],
    coverage: {
      status: "limited",
      discoveredRefs: 1,
      summaryEligibleRefs: 1,
      fullyExtractedRefs: 0,
      omittedEligibleRefs: 1,
      limitations: [{ kind: "candidate-cap", material: true }],
    },
  }));
  assert.equal(retainedStrong.includes("Possible related session: retained-strong"), true);
});

test("renders none and unavailable as distinct bounded statuses", () => {
  assert.equal(renderCorrelation(result("none")), [
    "Codex evidence",
    "  No reliable Codex session match found",
    "  Coverage: complete",
  ].join("\n"));
  assert.equal(renderCorrelation(result("unavailable", {
    coverage: {
      status: "unavailable",
      discoveredRefs: 0,
      summaryEligibleRefs: 0,
      fullyExtractedRefs: 0,
      omittedEligibleRefs: 0,
      limitations: [{ kind: "discovery-unavailable", material: true }],
    },
  })), [
    "Codex evidence",
    "  Codex history unavailable",
    "  Coverage: unavailable; Codex history could not be read",
  ].join("\n"));
});

function textReport(
  provenanceState: "committed" | "uncommitted",
  targetState: "clean" | "untracked",
  correlation?: CorrelationResult,
): WhylineReport {
  return {
    repository: {
      worktreeRoot: "/repo",
      gitDir: "/repo/.git",
      commonGitDir: "/repo/.git",
      objectFormat: "sha1",
      isShallow: false,
      headCommit: "head",
      branch: "main",
      worktrees: [],
    },
    location: {
      input: "src/target.ts:1",
      absolutePath: "/repo/src/target.ts",
      repositoryPath: "src/target.ts",
      requestedLine: 1,
      lineContent: "line",
      lineDigest: "digest",
      fileSnapshot: { size: 4, mtimeMs: 0, ino: 1, dev: 1, digest: "digest" },
      targetState,
      targetDirty: targetState === "untracked",
    },
    provenance: {
      state: provenanceState,
      targetDirty: targetState === "untracked",
      targetState,
      blame: null,
      commit: null,
      parent: null,
      changedPaths: [],
      relevantHunks: [],
      limitations: [],
    },
    ...(correlation === undefined ? {} : { correlation }),
  };
}

test("attaches Codex evidence only to committed reports", () => {
  const correlation = result("none");
  const committed = renderText(textReport("committed", "clean", correlation));
  assert.equal(committed.includes("Codex evidence"), true);

  const uncommitted = renderText(textReport("uncommitted", "clean", correlation));
  const uncommittedWithoutCorrelation = renderText(textReport("uncommitted", "clean"));
  assert.equal(uncommitted, uncommittedWithoutCorrelation);
  assert.equal(uncommitted.includes("Codex evidence"), false);

  const untracked = renderText(textReport("uncommitted", "untracked", correlation));
  assert.equal(untracked.includes("Codex evidence"), false);
});
