import assert from "node:assert/strict";
import test from "node:test";

import type { CorrelationCandidate, CorrelationResult } from "../src/correlation/model.js";
import type {
  GitBlameAttribution,
  GitCommit,
  ParentSelection,
  RepositoryContext,
} from "../src/provenance/model.js";
import type {
  RangeAncestryCoverage,
  RangeCorrelationGroup,
  RangeTextualGroup,
  WhylineRangeReport,
} from "../src/provenance/range-model.js";
import { renderRangeDetails } from "../src/cli/render-range-details.js";
import { renderRangeSummary } from "../src/cli/render-range-summary.js";

const parentId = "1111111111111111111111111111111111111111";

function commit(id: string, subject: string): GitCommit {
  return {
    basis: "fact",
    id,
    parents: [parentId],
    authorName: "Author",
    authorEmail: "author@example.test",
    authoredAt: "2026-08-11T00:00:00Z",
    committerName: "Committer",
    committerEmail: "committer@example.test",
    committedAt: "2026-08-11T00:00:00Z",
    subject,
    body: "private body and prompt must stay bounded",
    bodyTruncated: false,
  };
}

function blame(line: number, objectId: string, filename: string, uncommitted = false): GitBlameAttribution {
  return {
    basis: "fact",
    objectId,
    uncommitted,
    originalLine: line,
    finalLine: line,
    authorName: "Author",
    authorEmail: "author@example.test",
    authorTime: "1",
    authorTimezone: "+0000",
    committerName: "Committer",
    committerEmail: "committer@example.test",
    committerTime: "1",
    committerTimezone: "+0000",
    filename,
    previousCommit: null,
    previousPath: null,
    blobId: null,
    lineContent: "line " + line,
  };
}

function parent(): ParentSelection {
  return { basis: "derived", kind: "commit", commitId: parentId, evidence: "sole-parent" };
}

function group(
  id: string,
  startLine: number,
  endLine: number,
  value: GitCommit | null,
  uncommitted = false,
): RangeTextualGroup {
  const objectId = value?.id ?? "0000000000000000000000000000000000000000";
  return {
    id,
    spans: [{ startLine, endLine }],
    lines: Array.from(
      { length: endLine - startLine + 1 },
      (_value, index) => {
        const line = startLine + index;
        return { queryLine: line, blame: blame(line, objectId, "src/parser.ts", uncommitted) };
      },
    ),
    state: uncommitted ? "uncommitted" : "committed",
    commit: value,
    parent: uncommitted ? null : parent(),
    blamedPath: "src/parser.ts",
    changedPaths: [],
    relevantHunks: [],
    limitations: [],
  };
}

function candidate(sessionId: string): CorrelationCandidate {
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
      evidenceIds: ["private evidence id"],
    }],
    contradictions: [],
    band: "strong",
    coverage: "complete",
    coverageLimitations: [],
  };
}

function correlation(status: CorrelationResult["status"], selected?: CorrelationCandidate): CorrelationResult {
  return {
    status,
    ...(selected === undefined ? {} : { selected }),
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
  };
}

function report(
  groups: readonly RangeTextualGroup[],
  ancestry: ReadonlyMap<string, RangeAncestryCoverage>,
  correlations: readonly RangeCorrelationGroup[],
): WhylineRangeReport {
  const repository: RepositoryContext = {
    worktreeRoot: "/repo",
    gitDir: "/repo/.git",
    commonGitDir: "/repo/.git",
    objectFormat: "sha1",
    isShallow: false,
    headCommit: "head",
    branch: "main",
    worktrees: [],
  };
  const firstLine = groups[0]?.spans[0]?.startLine ?? 1;
  const lastLine = groups.at(-1)?.spans.at(-1)?.endLine ?? firstLine;
  return {
    repository,
    location: {
      input: "src/parser.ts:" + firstLine + "-" + lastLine,
      absolutePath: "/repo/src/parser.ts",
      repositoryPath: "src/parser.ts",
      startLine: firstLine,
      endLine: lastLine,
      lineContents: Array.from({ length: lastLine - firstLine + 1 }, (_value, index) => "line " + (firstLine + index)),
      lineDigests: [],
      fileSnapshot: { size: 1, mtimeMs: 0, ino: 1, dev: 1, digest: "digest" },
      targetState: "clean",
      targetDirty: false,
    },
    lineAttributions: groups.flatMap((value) => value.lines),
    textualGroups: groups,
    ancestry,
    correlations,
    coverage: {
      committedGroups: groups.filter((value) => value.state === "committed").length,
      deepAnalyzedGroups: correlations.filter((value) => value.status !== "work-bound").length,
      workBoundGroups: correlations.filter((value) => value.status === "work-bound").length,
      uncommittedGroups: groups.filter((value) => value.state === "uncommitted").length,
    },
  };
}

const exactCoverage: RangeAncestryCoverage = {
  segments: [{
    span: { startLine: 40, endLine: 47 },
    status: "exact",
    ancestor: { commitId: "31ca207abcdef", path: "src/legacy-parser.ts", line: 86 },
    ancestorSubject: "add token parser",
    transition: "same-file-move",
    proof: {
      basis: "derived",
      currentStartLine: 40,
      ancestorStartLine: 86,
      matchedLineCount: 8,
      distinctiveLineCount: 4,
      alphanumericCount: 160,
      comparison: "exact-lines",
    },
    limitations: [],
  }],
  limitations: [],
};

test("renders mixed range evidence without collapsing domains", () => {
  const first = group("textual-1", 40, 47, commit("9f2ab41abcdef", "refactor: split parser"));
  const second = group("textual-2", 48, 53, commit("771ca20abcdef", "handle escaped tokens"));
  const dirty = group("textual-3", 54, 55, null, true);
  const output = renderRangeSummary(report(
    [first, second, dirty],
    new Map([
      [first.id, exactCoverage],
      [second.id, {
        segments: [{ span: { startLine: 48, endLine: 53 }, status: "none", limitations: ["not established"] }],
        limitations: ["not established"],
      }],
      [dirty.id, {
        segments: [{ span: { startLine: 54, endLine: 55 }, status: "not-run", limitations: ["dirty"] }],
        limitations: ["dirty"],
      }],
    ]),
    [
      { groupId: first.id, spans: first.spans, status: "matched", result: correlation("matched", candidate("0f83abcd")) , limitations: [] },
      { groupId: second.id, spans: second.spans, status: "none", result: correlation("none"), limitations: [] },
    ],
  ));

  assert.match(output, /src\/parser\.ts:40-55/);
  assert.match(output, /40-47/);
  assert.match(output, /48-53/);
  assert.match(output, /54-55\s+uncommitted/);
  assert.match(output, /exact predecessor/);
  assert.match(output, /no reliable Codex match|no reliable Codex/i);
  assert.doesNotMatch(output, /originated|semantic origin|original commit/i);
  assert.doesNotMatch(output, /private\/transcript|private evidence id|private body/);
});

test("details include forensic group evidence but not private transcript material", () => {
  const first = group("textual-1", 40, 47, commit("9f2ab41abcdef", "refactor: split parser"));
  const output = renderRangeDetails(report(
    [first],
    new Map([[first.id, exactCoverage]]),
    [{ groupId: first.id, spans: first.spans, status: "matched", result: correlation("matched", candidate("session-a")), limitations: [] }],
  ));
  assert.match(output, /Textual groups/);
  assert.match(output, /selected parent|parent/i);
  assert.match(output, /Exact ancestry/);
  assert.match(output, /proof/i);
  assert.match(output, /Codex/);
  assert.doesNotMatch(output, /private\/transcript|private evidence id|private body/);
});

test("reports exact group omissions for summary and details bounds", () => {
  const groups = Array.from({ length: 65 }, (_value, index) => {
    const line = index + 1;
    return group("textual-" + (index + 1), line, line, commit(
      ("a".repeat(39) + (index + 1).toString(16)).slice(0, 40),
      "subject " + (index + 1),
    ));
  });
  const ancestry = new Map(groups.map((value) => [
    value.id,
    { segments: [{ span: value.spans[0] as { startLine: number; endLine: number }, status: "none" as const, limitations: [] }], limitations: [] },
  ]));
  const correlations = groups.map((value) => ({
    groupId: value.id,
    spans: value.spans,
    status: "none" as const,
    result: correlation("none"),
    limitations: [],
  }));
  const summary = renderRangeSummary(report(groups.slice(0, 13), ancestry, correlations.slice(0, 13)));
  const details = renderRangeDetails(report(groups, ancestry, correlations));
  assert.match(summary, /omitted 1 group|1 group.*narrower/i);
  assert.match(details, /omitted 1 group|1 group.*narrower/i);
  assert.equal((summary.match(/Textual last-touch/g) ?? []).length <= 12, true);
});
