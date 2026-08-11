import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GitResult, GitRunner } from "../src/git/git-process.js";
import { GitProcess } from "../src/git/git-process.js";
import { blameRange } from "../src/git/blame-range.js";
import { discoverRepositoryContext } from "../src/git/repository-context.js";
import { inspectRangeFacts } from "../src/git/inspect-range.js";
import { parseLocationQuery } from "../src/location/parse-location.js";
import { resolveRangeLocation } from "../src/location/resolve-location.js";
import type {
  GitBlameAttribution,
  GitCommit,
  ParentSelection,
} from "../src/provenance/model.js";
import {
  groupTextualAttributions,
  type RangeLineAttribution,
  type RangeLineInspection,
} from "../src/provenance/range-model.js";

const COMMIT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PARENT_A = "1111111111111111111111111111111111111111";
const PARENT_B = "2222222222222222222222222222222222222222";

function blame(
  queryLine: number,
  objectId: string,
  filename: string,
  uncommitted = false,
): RangeLineAttribution {
  const value: GitBlameAttribution = {
    basis: "fact",
    objectId,
    uncommitted,
    originalLine: queryLine,
    finalLine: queryLine,
    authorName: null,
    authorEmail: null,
    authorTime: null,
    authorTimezone: null,
    committerName: null,
    committerEmail: null,
    committerTime: null,
    committerTimezone: null,
    filename,
    previousCommit: null,
    previousPath: null,
    blobId: null,
    lineContent: "line " + queryLine,
  };
  return { queryLine, blame: value };
}

function commit(id: string): GitCommit {
  return {
    basis: "fact",
    id,
    parents: [PARENT_A],
    authorName: "Author",
    authorEmail: "author@example.test",
    authoredAt: "2026-08-11T00:00:00Z",
    committerName: "Committer",
    committerEmail: "committer@example.test",
    committedAt: "2026-08-11T00:00:00Z",
    subject: "subject",
    body: "",
    bodyTruncated: false,
  };
}

function inspection(
  value: GitCommit | null,
  parent: ParentSelection | null,
): RangeLineInspection {
  return {
    commit: value,
    parent,
    changedPaths: [],
    relevantHunks: [],
    limitations: [],
  };
}

test("groups contiguous and non-contiguous equivalent committed facts", () => {
  const facts = [1, 2, 5, 6].map((line) => blame(line, COMMIT_A, "src/parser.ts"));
  const parent: ParentSelection = {
    basis: "derived",
    kind: "commit",
    commitId: PARENT_A,
    evidence: "sole-parent",
  };
  const inspections = new Map(facts.map((fact) => [
    fact.queryLine,
    inspection(commit(COMMIT_A), parent),
  ]));

  const groups = groupTextualAttributions(facts, inspections);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.spans, [
    { startLine: 1, endLine: 2 },
    { startLine: 5, endLine: 6 },
  ]);
  assert.equal(groups[0]?.lines.length, 4);
});

test("preserves mixed commits, paths, parents, and uncommitted state", () => {
  const facts = [
    blame(1, COMMIT_A, "src/parser.ts"),
    blame(2, COMMIT_A, "src/parser.ts"),
    blame(3, COMMIT_A, "src/legacy-parser.ts"),
    blame(4, COMMIT_B, "src/parser.ts"),
    blame(5, "0000000000000000000000000000000000000000", "src/parser.ts", true),
  ];
  const parentA: ParentSelection = {
    basis: "derived",
    kind: "commit",
    commitId: PARENT_A,
    evidence: "sole-parent",
  };
  const parentB: ParentSelection = {
    basis: "derived",
    kind: "commit",
    commitId: PARENT_B,
    evidence: "blame-previous",
  };
  const inspections = new Map<number, RangeLineInspection>([
    [1, inspection(commit(COMMIT_A), parentA)],
    [2, inspection(commit(COMMIT_A), parentA)],
    [3, inspection(commit(COMMIT_A), parentA)],
    [4, inspection(commit(COMMIT_B), parentB)],
    [5, inspection(null, null)],
  ]);

  const groups = groupTextualAttributions(facts, inspections);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map((group) => group.spans), [
    [{ startLine: 1, endLine: 2 }],
    [{ startLine: 3, endLine: 3 }],
    [{ startLine: 4, endLine: 4 }],
    [{ startLine: 5, endLine: 5 }],
  ]);
  assert.deepEqual(groups.map((group) => group.state), [
    "committed",
    "committed",
    "committed",
    "uncommitted",
  ]);
  assert.equal(groups.reduce((total, group) => total + group.lines.length, 0), facts.length);
  assert.equal(groups[0]?.blamedPath, "src/parser.ts");
  assert.equal(groups[1]?.blamedPath, "src/legacy-parser.ts");
  assert.equal(groups[2]?.parent?.kind, "commit");
  assert.equal(groups[2]?.parent?.kind === "commit" && groups[2].parent.commitId, PARENT_B);
});

class CountingRunner implements GitRunner {
  public readonly calls: Array<readonly string[]> = [];

  public constructor(private readonly delegate: GitRunner) {}

  public run(
    args: readonly string[],
    options: { readonly cwd: string; readonly input?: Uint8Array },
  ): Promise<GitResult> {
    this.calls.push([...args]);
    return this.delegate.run(args, options);
  }
}

test("inspects repeated textual evidence with one metadata and diff set", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-range-inspection-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const globalConfig = path.join(directory, "empty-gitconfig");
  await writeFile(globalConfig, "", "utf8");
  const base = new GitProcess({
    environment: {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    },
  });
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "Whyline Test"],
    ["config", "user.email", "whyline@example.test"],
  ] as const) {
    const result = await base.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }
  const relativePath = "src/repeated.ts";
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(
    path.join(directory, relativePath),
    "const distinctiveAlpha = 123;\nconst distinctiveBeta = 456;\n",
    "utf8",
  );
  for (const args of [["add", "--", relativePath], ["commit", "--no-verify", "-m", "range fixture"]] as const) {
    const result = await base.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const repository = await discoverRepositoryContext(base, directory);
  const query = parseLocationQuery(relativePath + ":1-2");
  assert.equal(query.kind, "range");
  if (query.kind !== "range") throw new Error("expected range query");
  const location = await resolveRangeLocation(query, repository, base, directory);
  const facts = await blameRange(base, repository, relativePath, 1, 2);
  const counting = new CountingRunner(base);
  const inspections = await inspectRangeFacts(counting, repository, location, facts);

  assert.equal(inspections.size, 2);
  assert.equal(counting.calls.filter((args) => args.includes("commit inspection")).length, 0);
  assert.equal(counting.calls.filter((args) => args[0] === "show").length, 1, JSON.stringify(counting.calls));
  assert.equal(counting.calls.filter((args) => args.includes("diff-tree")).length, 1, JSON.stringify(counting.calls));
  assert.equal(counting.calls.filter((args) => args.includes("diff")).length, 1, JSON.stringify(counting.calls));
});
