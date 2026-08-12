import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitProcess, type GitRunner } from "../src/git/git-process.js";
import { traceLineAncestry } from "../src/git/trace-line-ancestry.js";
import { analyzeLocation } from "../src/provenance/explain-location.js";
import type { WhylineReport } from "../src/provenance/model.js";

interface Fixture {
  readonly directory: string;
  readonly codexHome: string;
  readonly runner: GitProcess;
}

async function git(fixture: Fixture, args: readonly string[]): Promise<Buffer> {
  const result = await fixture.runner.run(args, { cwd: fixture.directory });
  assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  return result.stdout;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-declaration-git-"));
  const globalConfig = path.join(directory, "empty-gitconfig");
  const codexHome = path.join(directory, "codex-home");
  await writeFile(globalConfig, "", "utf8");
  await mkdir(codexHome, { recursive: true });
  const runner = new GitProcess({
    environment: {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
      CODEX_HOME: codexHome,
    },
  });
  const initialized = await runner.run(["init", "--initial-branch=main"], { cwd: directory });
  assert.equal(initialized.exitCode, 0, initialized.stderr.toString("utf8"));
  const configFixture = { directory, codexHome, runner };
  await git(configFixture, ["config", "user.name", "Whyline Declaration"]);
  await git(configFixture, ["config", "user.email", "declaration@example.test"]);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return configFixture;
}

async function writeFixtureFile(
  fixtureValue: Fixture,
  repositoryPath: string,
  lines: readonly string[],
): Promise<void> {
  const filePath = path.join(fixtureValue.directory, repositoryPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

async function commitFixture(
  fixtureValue: Fixture,
  repositoryPath: string,
  message: string,
): Promise<string> {
  await git(fixtureValue, ["add", "--", repositoryPath]);
  await git(fixtureValue, ["commit", "--no-verify", "-m", message]);
  return (await git(fixtureValue, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

async function analyze(
  fixtureValue: Fixture,
  repositoryPath: string,
  line: number,
): Promise<WhylineReport> {
  return analyzeLocation(repositoryPath + ":" + line, {
    currentDirectory: fixtureValue.directory,
    git: fixtureValue.runner,
    codexHome: fixtureValue.codexHome,
  });
}

const parentDeclaration = [
  "function parseToken(input: string): string {",
  "  const anchorOne = \"direct parent declaration alpha parser marker with preserved detail\";",
  "  const anchorTwo = \"direct parent declaration beta parser marker with preserved detail\";",
  "  return input.trim();",
  "}",
];

test("traces a changed line through a verified direct-parent declaration correspondence", async (t) => {
  const f = await fixture(t);
  const repositoryPath = "src/parser.ts";
  await writeFixtureFile(f, repositoryPath, parentDeclaration);
  const parent = await commitFixture(f, repositoryPath, "add parser declaration");
  await writeFixtureFile(f, repositoryPath, [
    parentDeclaration[0] as string,
    parentDeclaration[1] as string,
    parentDeclaration[2] as string,
    "  const editedLine = input.toUpperCase();",
    parentDeclaration[3] as string,
    parentDeclaration[4] as string,
  ]);
  const textual = await commitFixture(f, repositoryPath, "edit parser declaration");

  const report = await analyze(f, repositoryPath, 4);
  assert.equal(report.provenance.commit?.id, textual);
  const result = await traceLineAncestry(
    f.runner,
    report.repository,
    report.location,
    report.provenance,
  );

  assert.equal(result.status, "transformed");
  if (result.status !== "transformed") return;
  assert.equal(result.relationship, "direct-parent-declaration");
  assert.equal(result.textualCommitId, textual);
  assert.equal(result.parentCommitId, parent);
  assert.equal(result.childPath, repositoryPath);
  assert.equal(result.parentPath, repositoryPath);
  assert.equal(result.childDeclaration.qualifiedName, "parseToken");
  assert.equal(result.parentDeclaration.qualifiedName, "parseToken");
  assert.equal(result.hunk.connection, "parent-overlap");
  assert.equal(result.anchor.distinctiveLineCount >= 2, true);
  assert.equal(result.anchor.alphanumericCount >= 40, true);
});

test("exact ancestry remains exact when the queried block is unchanged", async (t) => {
  const f = await fixture(t);
  const repositoryPath = "src/parser.ts";
  const before = Array.from({ length: 10 }, (_value, index) => "const before" + index + " = true;");
  const after = Array.from({ length: 10 }, (_value, index) => "const after" + index + " = true;");
  await writeFixtureFile(f, repositoryPath, [
    ...before,
    ...parentDeclaration,
    ...after,
  ]);
  const parent = await commitFixture(f, repositoryPath, "add parser block");
  await writeFixtureFile(f, repositoryPath, [
    ...before,
    ...after,
    ...parentDeclaration,
  ]);
  const textual = await commitFixture(f, repositoryPath, "move parser block");
  const report = await analyze(f, repositoryPath, 22);
  assert.equal(report.provenance.commit?.id, textual);
  const result = await traceLineAncestry(f.runner, report.repository, report.location, report.provenance);
  assert.equal(result.status, "exact");
  if (result.status !== "exact") return;
  assert.equal(result.ancestor.commitId, parent);
});

test("maps a transformed declaration through one directly observed Git rename", async (t) => {
  const f = await fixture(t);
  const sourcePath = "src/legacy-parser.ts";
  const targetPath = "src/parser.ts";
  await writeFixtureFile(f, sourcePath, parentDeclaration);
  const parent = await commitFixture(f, sourcePath, "add legacy parser declaration");
  await git(f, ["mv", "--", sourcePath, targetPath]);
  await writeFixtureFile(f, targetPath, [
    parentDeclaration[0] as string,
    parentDeclaration[1] as string,
    parentDeclaration[2] as string,
    "  const editedLine = input.toUpperCase();",
    parentDeclaration[3] as string,
    parentDeclaration[4] as string,
  ]);
  await git(f, ["add", "-A"]);
  await git(f, ["commit", "--no-verify", "-m", "rename and edit parser declaration"]);
  const textual = (await git(f, ["rev-parse", "HEAD"])).toString("utf8").trim();

  const report = await analyze(f, targetPath, 4);
  assert.equal(report.provenance.commit?.id, textual);
  const result = await traceLineAncestry(f.runner, report.repository, report.location, report.provenance);
  assert.equal(result.status, "transformed");
  if (result.status !== "transformed") return;
  assert.equal(result.parentCommitId, parent);
  assert.equal(result.childPath, targetPath);
  assert.equal(result.parentPath, sourcePath);
});

test("does not attempt transformed correspondence at a root or ambiguous parent", async (t) => {
  const f = await fixture(t);
  const repositoryPath = "src/parser.ts";
  await writeFixtureFile(f, repositoryPath, parentDeclaration);
  const root = await commitFixture(f, repositoryPath, "root parser declaration");
  const rootReport = await analyze(f, repositoryPath, 4);
  assert.equal(rootReport.provenance.commit?.id, root);
  const rootResult = await traceLineAncestry(f.runner, rootReport.repository, rootReport.location, rootReport.provenance);
  assert.equal(rootResult.status, "none");
  if (rootResult.status !== "none") return;
  assert.equal(rootResult.reason, "root-history-boundary");

  const ambiguousResult = await traceLineAncestry(
    f.runner,
    rootReport.repository,
    rootReport.location,
    {
      ...rootReport.provenance,
      parent: { basis: "derived", kind: "ambiguous", parentIds: ["parent-a", "parent-b"] },
    },
  );
  assert.equal(ambiguousResult.status, "unavailable");
  if (ambiguousResult.status !== "unavailable") return;
  assert.equal(ambiguousResult.reason, "ambiguous-parent");
});

test("historical syntax errors and unreadable blobs remain unavailable", async (t) => {
  const f = await fixture(t);
  const repositoryPath = "src/parser.ts";
  await writeFixtureFile(f, repositoryPath, parentDeclaration);
  await commitFixture(f, repositoryPath, "add parser declaration");
  await writeFixtureFile(f, repositoryPath, [
    parentDeclaration[0] as string,
    parentDeclaration[1] as string,
    parentDeclaration[2] as string,
    "  const editedLine = input.toUpperCase();",
    parentDeclaration[3] as string,
    parentDeclaration[4] as string,
  ]);
  await commitFixture(f, repositoryPath, "edit parser declaration");
  const validReport = await analyze(f, repositoryPath, 4);
  const unreadableRunner: GitRunner = {
    run: (args, options) => args[0] === "cat-file" && args[1] === "blob"
      ? Promise.resolve({ stdout: Buffer.from([0xff, 0xfe]), stderr: Buffer.alloc(0), exitCode: 0, signal: null })
      : f.runner.run(args, options),
  };
  const unreadableResult = await traceLineAncestry(unreadableRunner, validReport.repository, validReport.location, validReport.provenance);
  assert.equal(unreadableResult.status, "unavailable");
  if (unreadableResult.status !== "unavailable") return;
  assert.equal(unreadableResult.reason, "unsupported-object");

  await writeFixtureFile(f, repositoryPath, [
    parentDeclaration[0] as string,
    parentDeclaration[1] as string,
    parentDeclaration[2] as string,
    "  const broken = ;",
    parentDeclaration[3] as string,
    parentDeclaration[4] as string,
  ]);
  await commitFixture(f, repositoryPath, "write invalid parser declaration");
  const report = await analyze(f, repositoryPath, 4);
  const syntaxResult = await traceLineAncestry(f.runner, report.repository, report.location, report.provenance);
  assert.equal(syntaxResult.status, "unavailable");
  if (syntaxResult.status !== "unavailable") return;
  assert.equal(syntaxResult.reason, "unsupported-object");
});

test("enforces the historical blob bound before declaration parsing", async (t) => {
  const f = await fixture(t);
  const repositoryPath = "src/parser.ts";
  await writeFixtureFile(f, repositoryPath, parentDeclaration);
  await commitFixture(f, repositoryPath, "add parser declaration");
  await writeFixtureFile(f, repositoryPath, [
    parentDeclaration[0] as string,
    parentDeclaration[1] as string,
    parentDeclaration[2] as string,
    "  const editedLine = input.toUpperCase();",
    parentDeclaration[3] as string,
    parentDeclaration[4] as string,
  ]);
  await commitFixture(f, repositoryPath, "edit parser declaration");
  const report = await analyze(f, repositoryPath, 4);
  const oversizedRunner: GitRunner = {
    run: (args, options) => args[0] === "cat-file" && args[1] === "blob"
      ? Promise.resolve({ stdout: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), stderr: Buffer.alloc(0), exitCode: 0, signal: null })
      : f.runner.run(args, options),
  };
  const result = await traceLineAncestry(oversizedRunner, report.repository, report.location, report.provenance);
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "work-bound");
});

test("keeps transformed historical loading argv-safe for leading-dash paths", async (t) => {
  const f = await fixture(t);
  const repositoryPath = "src/--parser.ts";
  await writeFixtureFile(f, repositoryPath, parentDeclaration);
  const parent = await commitFixture(f, repositoryPath, "add unusual parser path");
  await writeFixtureFile(f, repositoryPath, [
    parentDeclaration[0] as string,
    parentDeclaration[1] as string,
    parentDeclaration[2] as string,
    "  const editedLine = input.toUpperCase();",
    parentDeclaration[3] as string,
    parentDeclaration[4] as string,
  ]);
  const textual = await commitFixture(f, repositoryPath, "edit unusual parser path");
  const report = await analyze(f, repositoryPath, 4);
  const calls: string[][] = [];
  const recordingRunner: GitRunner = {
    run: (args, options) => {
      calls.push([...args]);
      return f.runner.run(args, options);
    },
  };
  const result = await traceLineAncestry(recordingRunner, report.repository, report.location, report.provenance);
  assert.equal(result.status, "transformed");
  if (result.status !== "transformed") return;
  assert.equal(result.textualCommitId, textual);
  assert.equal(result.parentCommitId, parent);
  assert.ok(calls.some((args) => args[0] === "ls-tree" && args.includes("--") && args.includes(repositoryPath)));
  assert.equal(calls.some((args) => args.includes("--parser.ts") && args[0] !== "ls-tree"), false);
});
