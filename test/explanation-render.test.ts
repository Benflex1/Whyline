import assert from "node:assert/strict";
import test from "node:test";

import type { CorrelationCandidate, CorrelationResult } from "../src/correlation/model.js";
import type { GitAncestryResult } from "../src/ancestry/model.js";
import { renderSummary } from "../src/cli/render-summary.js";
import { renderText } from "../src/cli/render-text.js";
import type { WhylineReport } from "../src/provenance/model.js";

function candidate(sessionId: string, band: CorrelationCandidate["band"] = "strong"): CorrelationCandidate {
  return {
    session: {
      ref: { adapterId: "codex", sourcePath: "/private/transcript.jsonl", sourceKind: "active" },
      sessionId,
      initialCwd: "/private/worktree",
      workingDirectories: ["/private/worktree"],
      isPartial: false,
      diagnostics: [],
    },
    eligible: true,
    repositoryMatch: "current-worktree",
    score: 100,
    signals: [{
      kind: "structured-patch-overlap",
      weight: 8,
      basis: "derived",
      evidenceIds: ["secret evidence id"],
    }],
    contradictions: [],
    band,
    coverage: "complete",
    coverageLimitations: [],
  };
}

function correlation(
  status: CorrelationResult["status"],
  overrides: Partial<CorrelationResult> = {},
): CorrelationResult {
  return {
    status,
    alternatives: [],
    coverage: {
      status: "complete",
      discoveredRefs: 1,
      usableSummaryRefs: 1,
      incompatibleRefs: 0,
      provenNotStrongRefs: 0,
      potentiallyStrongRefs: 1,
      fullyProjectedRefs: 1,
      omittedPotentiallyStrongRefs: 0,
      limitations: [],
    },
    ...overrides,
  };
}

const exact: GitAncestryResult = {
  status: "exact",
  relationship: "exact-ancestor",
  transition: "same-file-move",
  ancestor: { commitId: "31ca207abcdef", path: "src/legacy-parser.ts", line: 88 },
  ancestorSubject: "add token parser",
  proof: {
    basis: "derived",
    currentStartLine: 40,
    ancestorStartLine: 86,
    matchedLineCount: 4,
    distinctiveLineCount: 3,
    alphanumericCount: 96,
    comparison: "exact-lines",
  },
  limitations: ["visible history only"],
};

function report(
  ancestry: GitAncestryResult | undefined,
  correlationResult: CorrelationResult | undefined,
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
      input: "src/parser.ts:42",
      absolutePath: "/repo/src/parser.ts",
      repositoryPath: "src/parser.ts",
      requestedLine: 42,
      lineContent: "const parserAnchor = true;",
      lineDigest: "digest",
      fileSnapshot: { size: 26, mtimeMs: 0, ino: 1, dev: 1, digest: "digest" },
      targetState: "clean",
      targetDirty: false,
    },
    provenance: {
      state: "committed",
      targetDirty: false,
      targetState: "clean",
      blame: {
        basis: "fact",
        objectId: "9f2ab41abcdef",
        uncommitted: false,
        originalLine: 42,
        finalLine: 42,
        authorName: "Author",
        authorEmail: "author@example.test",
        authorTime: "1",
        authorTimezone: "+0000",
        committerName: "Committer",
        committerEmail: "committer@example.test",
        committerTime: "1",
        committerTimezone: "+0000",
        filename: "src/parser.ts",
        previousCommit: null,
        previousPath: null,
        blobId: null,
        lineContent: "const parserAnchor = true;",
      },
      commit: {
        basis: "fact",
        id: "9f2ab41abcdef",
        parents: ["parent"],
        authorName: "Author",
        authorEmail: "author@example.test",
        authoredAt: "2026-08-11T00:00:00Z",
        committerName: "Committer",
        committerEmail: "committer@example.test",
        committedAt: "2026-08-11T00:00:00Z",
        subject: "refactor: split parser",
        body: "private body must stay details-only",
        bodyTruncated: false,
      },
      parent: { basis: "derived", kind: "commit", commitId: "parent", evidence: "sole-parent" },
      changedPaths: [],
      relevantHunks: [],
      limitations: [],
    },
    ...(ancestry === undefined ? {} : { ancestry }),
    ...(correlationResult === undefined ? {} : { correlation: correlationResult }),
  };
}

test("default summary is concise, outcome-first, and exact-ancestry specific", () => {
  const output = renderSummary(report(exact, correlation("matched", { selected: candidate("0f83abcdef", "strong") })));

  assert.equal(output, [
    "src/parser.ts:42",
    "",
    "Explanation",
    "  Textual last-touch: 9f2ab41 \"refactor: split parser\"",
    "  Git ancestry: exact code predates that commit",
    "    transition: same-file-move",
    "    moved/copied from src/legacy-parser.ts:88",
    "    earlier attribution: 31ca207 \"add token parser\"",
    "  AI provenance: likely Codex session 0f83abcdef",
    "    structured patch content overlaps the attributed change",
    "    Coverage: complete",
  ].join("\n"));
  assert.equal(output.includes("State"), false);
  assert.equal(output.includes("Relevant change"), false);
  assert.equal(output.includes("private body"), false);
  assert.equal(output.includes("originated"), false);
  assert.equal(output.includes("original commit"), false);
  assert.equal(output.includes("/private"), false);
  assert.equal(output.length < 1200, true);
});

test("none, uncertain, unavailable, and uncommitted summaries never claim origin", () => {
  const none: GitAncestryResult = {
    status: "none",
    reason: "no-earlier-move-copy-attribution",
    limitations: ["no candidate"],
  };
  const uncertain: GitAncestryResult = {
    status: "uncertain",
    reason: "insufficient-distinctive-context",
    candidate: { commitId: "candidate", path: "src/other.ts", line: 4 },
    limitations: ["insufficient"],
  };
  const unavailable: GitAncestryResult = {
    status: "unavailable",
    reason: "missing-history",
    limitations: ["shallow"],
  };

  assert.match(renderSummary(report(none, correlation("none"))), /Git ancestry: not established/);
  assert.match(renderSummary(report(uncertain, correlation("none"))), /Git ancestry: uncertain; Git suggested movement/);
  assert.match(renderSummary(report(unavailable, correlation("unavailable"))), /Git ancestry: unavailable/);
  for (const result of [none, uncertain, unavailable]) {
    assert.doesNotMatch(renderSummary(report(result, undefined)), /originated|original commit|introduced the idea/i);
  }
});

test("details retain forensic and ancestry proof material without transcript leakage", () => {
  const output = renderText(report(exact, correlation("ambiguous", {
    alternatives: [candidate("session-a"), candidate("session-b")],
  })));

  assert.match(output, /State/);
  assert.match(output, /Relevant change/);
  assert.match(output, /Git ancestry/);
  assert.match(output, /ancestor: 31ca207abcdef src\/legacy-parser\.ts:88/);
  assert.match(output, /proof: lines=4, distinctive=3, alphanumeric=96/);
  assert.match(output, /Multiple strong candidates/);
  assert.doesNotMatch(output, /private\/transcript|private\/worktree|secret evidence id/);
  assert.equal(output.length < 12000, true);
});

test("summary preserves Codex matched, ambiguous, and limited coverage distinctions", () => {
  const matched = renderSummary(report(undefined, correlation("matched", { selected: candidate("matched-session") })));
  const ambiguous = renderSummary(report(undefined, correlation("ambiguous", {
    alternatives: [candidate("first-session"), candidate("second-session")],
  })));
  const limited = renderSummary(report(undefined, correlation("none", {
    coverage: {
      status: "limited",
      discoveredRefs: 2,
      usableSummaryRefs: 2,
      incompatibleRefs: 0,
      provenNotStrongRefs: 0,
      potentiallyStrongRefs: 2,
      fullyProjectedRefs: 1,
      omittedPotentiallyStrongRefs: 1,
      limitations: [{ kind: "candidate-cap", material: true }],
    },
  })));

  assert.match(matched, /AI provenance: likely Codex session matched-session/);
  assert.match(ambiguous, /AI provenance: ambiguous/);
  assert.match(limited, /AI provenance: no reliable Codex match/);
  assert.match(limited, /Coverage: limited/);
});
