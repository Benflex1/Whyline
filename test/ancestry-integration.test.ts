import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitProcess, type GitRunner } from "../src/git/git-process.js";
import { analyzeLocation } from "../src/provenance/explain-location.js";

const BEFORE = Array.from({ length: 10 }, (_, index) => `const before${index} = \"before-${index}\";`);
const AFTER = Array.from({ length: 10 }, (_, index) => `const after${index} = \"after-${index}\";`);
const BLOCK = [
  "const integrationAnchor = \"integration exact ancestry anchor\";",
  "const integrationSecond = \"integration second ancestry anchor\";",
];

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-ancestry-integration-"));
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
  await git({ directory, codexHome, runner }, ["config", "user.name", "Whyline Integration"]);
  await git({ directory, codexHome, runner }, ["config", "user.email", "integration@example.test"]);
  await git({ directory, codexHome, runner }, ["config", "commit.gpgSign", "false"]);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, codexHome, runner };
}

async function writeTarget(fixtureValue: Fixture, lines: readonly string[]): Promise<void> {
  await writeFile(path.join(fixtureValue.directory, "src", "target.ts"), `${lines.join("\n")}\n`, "utf8");
}

async function commit(fixtureValue: Fixture, message: string): Promise<string> {
  await git(fixtureValue, ["add", "--", "src/target.ts"]);
  await git(fixtureValue, ["commit", "--no-verify", "-m", message]);
  return (await git(fixtureValue, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

async function committedFixture(t: test.TestContext): Promise<Fixture & { readonly base: string; readonly refactor: string }> {
  const f = await fixture(t);
  await mkdir(path.join(f.directory, "src"), { recursive: true });
  await writeTarget(f, [...BEFORE, ...BLOCK, ...AFTER]);
  const base = await commit(f, "add integration block");
  await writeTarget(f, [...BEFORE, ...AFTER, ...BLOCK]);
  const refactor = await commit(f, "refactor: move integration block");
  return { ...f, base, refactor };
}

test("committed reports attach ancestry without changing the correlation domain", async (t) => {
  const f = await committedFixture(t);
  const report = await analyzeLocation("src/target.ts:22", {
    currentDirectory: f.directory,
    git: f.runner,
    codexHome: f.codexHome,
  });

  assert.equal(report.provenance.state, "committed");
  assert.equal(report.provenance.commit?.id, f.refactor);
  assert.equal(report.ancestry?.status, "exact");
  if (report.ancestry?.status !== "exact") return;
  assert.equal(report.ancestry.ancestor.commitId, f.base);
  assert.equal(report.ancestry.ancestor.path, "src/target.ts");
  assert.equal(report.correlation?.status, "none");
});

test("uncommitted and untracked targets skip ancestry Git calls", async (t) => {
  const f = await committedFixture(t);
  const calls: string[][] = [];
  const recordingRunner: GitRunner = {
    run: (args, options) => {
      calls.push([...args]);
      return f.runner.run(args, options);
    },
  };

  await writeTarget(f, [...BEFORE, ...AFTER, "const locallyChanged = true;", ...BLOCK]);
  const dirty = await analyzeLocation("src/target.ts:21", {
    currentDirectory: f.directory,
    git: recordingRunner,
    codexHome: f.codexHome,
  });
  assert.equal(dirty.provenance.state, "uncommitted");
  assert.equal(dirty.ancestry, undefined);
  assert.equal(calls.some((args) => args.includes("-M") || args.includes("-C")), false);

  await writeFile(path.join(f.directory, "src", "new.ts"), "untracked\n", "utf8");
  const untracked = await analyzeLocation("src/new.ts:1", {
    currentDirectory: f.directory,
    git: recordingRunner,
    codexHome: f.codexHome,
  });
  assert.equal(untracked.provenance.state, "uncommitted");
  assert.equal(untracked.ancestry, undefined);
  assert.equal(calls.some((args) => args.includes("-M") || args.includes("-C")), false);
});
