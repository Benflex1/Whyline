import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBoundedUnifiedDiff } from "../src/git/bounded-unified-diff.js";
import { GitProcess, type GitResult, type GitRunner } from "../src/git/git-process.js";
import { inspectWorktreeChange } from "../src/git/inspect-worktree-change.js";
import { parseLocation } from "../src/location/parse-location.js";
import {
  resolvedCodeLocationFromSource,
  resolveCurrentSource,
  type CurrentSourceSnapshot,
} from "../src/location/resolve-location.js";
import { discoverRepositoryContext } from "../src/git/repository-context.js";

class RecordingRunner implements GitRunner {
  public readonly calls: string[][] = [];

  public constructor(private readonly delegate: GitRunner) {}

  public async run(args: readonly string[], options: { readonly cwd: string; readonly input?: Uint8Array }): Promise<GitResult> {
    (this.calls as string[][]).push([...args]);
    return this.delegate.run(args, options);
  }
}

async function checked(runner: GitRunner, directory: string, args: readonly string[]): Promise<Buffer> {
  const result = await runner.run(args, { cwd: directory });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
  return result.stdout;
}

async function writeFixture(directory: string, relativePath: string, content: string): Promise<void> {
  const filename = path.join(directory, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, "utf8");
}

async function realGitFixture(t: test.TestContext): Promise<{ readonly directory: string; readonly runner: GitProcess }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-worktree-git-"));
  const runner = new GitProcess({ environment: { GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", LANG: "C" } });
  await checked(runner, directory, ["init", "--initial-branch=main"]);
  await checked(runner, directory, ["config", "user.name", "Fixture"]);
  await checked(runner, directory, ["config", "user.email", "fixture@example.test"]);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, runner };
}

async function commitAll(fixture: { readonly directory: string; readonly runner: GitRunner }): Promise<void> {
  await checked(fixture.runner, fixture.directory, ["add", "-A"]);
  await checked(fixture.runner, fixture.directory, ["commit", "--no-verify", "-m", "fixture"]);
}

function diff(lines: readonly string[]): Buffer {
  return Buffer.from([
    "diff --git a/src/file.ts b/src/file.ts",
    "--- a/src/file.ts",
    "+++ b/src/file.ts",
    ...lines,
    "",
  ].join("\n"), "utf8");
}

test("bounded parser preserves added, deleted, context, metadata, and paths", () => {
  const hunks = parseBoundedUnifiedDiff(diff([
    "@@ -1,2 +1,3 @@",
    " context",
    "-deleted",
    "+added",
    "\\ No newline at end of file",
    "+second added",
  ]), 3);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    basis: "derived",
    oldPath: "src/file.ts",
    newPath: "src/file.ts",
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 3,
    targetLineKind: "added",
    lines: [
      { kind: "context", text: "context" },
      { kind: "deleted", text: "deleted" },
      { kind: "added", text: "added" },
      { kind: "metadata", text: " No newline at end of file" },
      { kind: "added", text: "second added" },
      { kind: "metadata", text: "" },
    ],
    raw: "@@ -1,2 +1,3 @@\n context\n-deleted\n+added\n\\ No newline at end of file\n+second added\n",
    truncated: false,
  });
});

test("bounded parser preserves file-start additions, adjacent hunks, and unusual paths", () => {
  const value = Buffer.from([
    "diff --git a/-old name.ts b/-new name.ts",
    "--- /dev/null",
    "+++ b/-new name.ts",
    "@@ -0,0 +1,1 @@",
    "+first",
    "@@ -9,1 +10,1 @@",
    "-before",
    "+after",
    "",
  ].join("\n"), "utf8");
  const hunks = parseBoundedUnifiedDiff(value, new Set([1, 10]));
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]?.oldStart, 0);
  assert.equal(hunks[0]?.oldLines, 0);
  assert.equal(hunks[0]?.newStart, 1);
  assert.equal(hunks[1]?.targetLineKind, "added");
});

test("bounded parser marks line and byte overflow without dropping target accounting", () => {
  const manyLines = Array.from({ length: 300 }, (_value, index) => `+line-${index}-${"x".repeat(180)}`);
  const hunks = parseBoundedUnifiedDiff(diff(["@@ -0,0 +1,300 @@", ...manyLines]), 300);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]?.lines.length, 256);
  assert.equal(hunks[0]?.truncated, true);
  assert.equal(hunks[0]?.targetLineKind, "added");

  const bytes = Array.from({ length: 256 }, () => "+" + "y".repeat(200));
  const byteBoundHunks = parseBoundedUnifiedDiff(diff(["@@ -0,0 +1,256 @@", ...bytes]), 1);
  assert.equal(byteBoundHunks[0]?.truncated, true);
});

test("single-line location construction reuses the resolved current source snapshot", () => {
  const source: CurrentSourceSnapshot = {
    absolutePath: "/workspace/project/src/file.ts",
    repositoryPath: "src/file.ts",
    text: "first\nsecond\n",
    lines: ["first", "second"],
    fileSnapshot: { size: 13, mtimeMs: 1, ino: 2, dev: 3, digest: "file" },
    targetState: "modified",
    targetDirty: true,
  };
  const location = resolvedCodeLocationFromSource(parseLocation("src/file.ts:2"), source);
  assert.equal(location.lineContent, "second");
  assert.equal(location.repositoryPath, source.repositoryPath);
  assert.equal(location.fileSnapshot, source.fileSnapshot);
  assert.equal(location.targetState, source.targetState);
});

test("inspects a tracked current-side update into one ready worktree target", async (t) => {
  const fixture = await realGitFixture(t);
  await writeFixture(fixture.directory, "src/target.ts", [
    "const stable = true;",
    "const oldAlpha = \"old-alpha\";",
    "const oldBeta = \"old-beta\";",
    "const tail = true;",
    "",
  ].join("\n"));
  await commitAll(fixture);
  await writeFixture(fixture.directory, "src/target.ts", [
    "const stable = true;",
    "const newAlpha = \"new-alpha-with-distinctive-material\";",
    "const newBeta = \"new-beta-with-distinctive-material\";",
    "const tail = true;",
    "",
  ].join("\n"));

  const recording = new RecordingRunner(fixture.runner);
  const repository = await discoverRepositoryContext(recording, fixture.directory);
  const source = await resolveCurrentSource("src/target.ts", repository, recording, fixture.directory);
  recording.calls.splice(0);
  const inspection = await inspectWorktreeChange(recording, repository, source, [2]);
  const construction = inspection.constructions[0];
  assert.equal(construction?.status, "ready");
  if (construction?.status !== "ready") return;
  assert.equal(construction.target.changeKind, "modified");
  assert.equal(construction.target.staging, "unstaged");
  assert.deepEqual(construction.target.queriedSpans, [{ startLine: 2, endLine: 2 }]);
  assert.equal(construction.target.relevantHunks[0]?.operation, "update");
  assert.equal(construction.target.relevantHunks[0]?.complete, true);
  assert.equal(construction.target.targetSnapshot.evidenceDigest, inspection.evidenceDigest);
  assert.equal(construction.target.relevantHunks[0]?.currentLineFingerprints.length, 2);
  assert.ok(inspection.evidenceDigest.length > 0);

  assert.deepEqual(recording.calls, [
    ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--", "src/target.ts"],
    ["ls-files", "--stage", "-z", "--", "src/target.ts"],
    ["ls-tree", "-z", "--full-tree", "HEAD", "--", "src/target.ts"],
    ["cat-file", "-s", "" + (await checked(fixture.runner, fixture.directory, ["ls-tree", "-z", "--full-tree", "HEAD", "--", "src/target.ts"])).toString("utf8").match(/[0-9a-f]{40}/)?.[0]],
    ["cat-file", "blob", "" + (await checked(fixture.runner, fixture.directory, ["ls-tree", "-z", "--full-tree", "HEAD", "--", "src/target.ts"])).toString("utf8").match(/[0-9a-f]{40}/)?.[0]],
    ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--", "src/target.ts"],
    ["diff", "--patch", "--unified=0", "--no-indent-heuristic", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", "src/target.ts"],
  ]);

  const allowed = new Set([
    "status", "ls-files", "ls-tree", "cat-file", "diff",
  ]);
  assert.equal(recording.calls.every((args) => allowed.has(args[0] ?? "")), true);
  assert.equal(recording.calls.some((args) => args[0] === "diff" && args.includes("--no-renames")), true);
});

test("an unchanged dirty queried line does not become a worktree target", async (t) => {
  const fixture = await realGitFixture(t);
  await writeFixture(fixture.directory, "dirty.ts", "const stable = true;\nconst old = \"old\";\n");
  await commitAll(fixture);
  await writeFixture(fixture.directory, "dirty.ts", "const stable = true;\nconst changed = \"changed with material\";\n");
  const repository = await discoverRepositoryContext(fixture.runner, fixture.directory);
  const source = await resolveCurrentSource("dirty.ts", repository, fixture.runner, fixture.directory);
  const inspection = await inspectWorktreeChange(fixture.runner, repository, source, [1]);
  assert.equal(inspection.constructions[0]?.status, "insufficient");
  assert.equal(inspection.constructions[0]?.reason, "query-not-current-side-change");
});

test("constructs final-content add targets for untracked and staged additions", async (t) => {
  const fixture = await realGitFixture(t);
  await writeFixture(fixture.directory, "README.md", "base\n");
  await commitAll(fixture);
  const content = "const first = \"distinctive-first-material\";\nconst second = \"distinctive-second-material\";\nconst third = true;\n";
  await writeFixture(fixture.directory, "src/new.ts", content);
  const repository = await discoverRepositoryContext(fixture.runner, fixture.directory);
  const untrackedSource = await resolveCurrentSource("src/new.ts", repository, fixture.runner, fixture.directory);
  const untracked = await inspectWorktreeChange(fixture.runner, repository, untrackedSource, [2]);
  assert.equal(untracked.constructions[0]?.status, "ready");
  assert.equal(untracked.constructions[0]?.status === "ready" ? untracked.constructions[0].target.changeKind : null, "added");
  assert.equal(untracked.constructions[0]?.status === "ready" ? untracked.constructions[0].target.staging : null, "untracked");

  await checked(fixture.runner, fixture.directory, ["add", "src/new.ts"]);
  const stagedSource = await resolveCurrentSource("src/new.ts", repository, fixture.runner, fixture.directory);
  const staged = await inspectWorktreeChange(fixture.runner, repository, stagedSource, [2]);
  assert.equal(staged.constructions[0]?.status, "ready");
  assert.equal(staged.constructions[0]?.status === "ready" ? staged.constructions[0].target.changeKind : null, "added");
});

test("treats intent-to-add as final current added content and keeps staging diagnostic-only", async (t) => {
  const fixture = await realGitFixture(t);
  await writeFixture(fixture.directory, "README.md", "base\n");
  await commitAll(fixture);
  await writeFixture(fixture.directory, "src/intent.ts", "const first = \"intent-first-material\";\nconst second = \"intent-second-material\";\n");
  await checked(fixture.runner, fixture.directory, ["add", "-N", "src/intent.ts"]);
  const repository = await discoverRepositoryContext(fixture.runner, fixture.directory);
  const source = await resolveCurrentSource("src/intent.ts", repository, fixture.runner, fixture.directory);
  const inspection = await inspectWorktreeChange(fixture.runner, repository, source, [2]);
  assert.equal(inspection.constructions[0]?.status, "ready");
  assert.equal(inspection.constructions[0]?.status === "ready" ? inspection.constructions[0].target.changeKind : null, "added");
  assert.equal(inspection.constructions[0]?.status === "ready" ? inspection.constructions[0].target.staging : null, "unstaged");
});

test("compares a partially staged path only from HEAD to final working-tree content", async (t) => {
  const fixture = await realGitFixture(t);
  await writeFixture(fixture.directory, "src/partial.ts", "const one = \"old-one\";\nconst two = \"old-two\";\n");
  await commitAll(fixture);
  await writeFixture(fixture.directory, "src/partial.ts", "const one = \"staged-one-material\";\nconst two = \"staged-two-material\";\n");
  await checked(fixture.runner, fixture.directory, ["add", "src/partial.ts"]);
  await writeFixture(fixture.directory, "src/partial.ts", "const one = \"final-one-material\";\nconst two = \"final-two-material\";\n");
  const repository = await discoverRepositoryContext(fixture.runner, fixture.directory);
  const source = await resolveCurrentSource("src/partial.ts", repository, fixture.runner, fixture.directory);
  const inspection = await inspectWorktreeChange(fixture.runner, repository, source, [2]);
  assert.equal(inspection.constructions[0]?.status, "ready");
  if (inspection.constructions[0]?.status !== "ready") return;
  assert.equal(inspection.constructions[0].target.staging, "partially-staged");
  assert.equal(inspection.constructions[0].target.relevantHunks[0]?.currentLineFingerprints.length, 2);
});

test("maps file-start current-side insertion without positional heuristics", async (t) => {
  const fixture = await realGitFixture(t);
  await writeFixture(fixture.directory, "src/start.ts", "const tail = true;\n");
  await commitAll(fixture);
  await writeFixture(fixture.directory, "src/start.ts", "const first = \"file-start-first-material\";\nconst second = \"file-start-second-material\";\nconst tail = true;\n");
  const repository = await discoverRepositoryContext(fixture.runner, fixture.directory);
  const source = await resolveCurrentSource("src/start.ts", repository, fixture.runner, fixture.directory);
  const inspection = await inspectWorktreeChange(fixture.runner, repository, source, [1]);
  assert.equal(inspection.constructions[0]?.status, "ready");
  assert.equal(inspection.constructions[0]?.status === "ready" ? inspection.constructions[0].target.relevantHunks[0]?.newStart : null, 1);
});

test("bounds a retained worktree hunk before attempting exact correlation", async (t) => {
  const fixture = await realGitFixture(t);
  const original = Array.from({ length: 300 }, (_value, index) => `const old${index} = \"old-material-${index}\";`).join("\n") + "\n";
  const updated = Array.from({ length: 300 }, (_value, index) => `const new${index} = \"new-material-${index}-with-distinctive-text\";`).join("\n") + "\n";
  await writeFixture(fixture.directory, "src/large-hunk.ts", original);
  await commitAll(fixture);
  await writeFixture(fixture.directory, "src/large-hunk.ts", updated);
  const repository = await discoverRepositoryContext(fixture.runner, fixture.directory);
  const source = await resolveCurrentSource("src/large-hunk.ts", repository, fixture.runner, fixture.directory);
  const inspection = await inspectWorktreeChange(fixture.runner, repository, source, [1]);
  assert.equal(inspection.constructions[0]?.status, "work-bound");
  assert.equal(inspection.constructions[0]?.reason, "hunk-too-large");
});
