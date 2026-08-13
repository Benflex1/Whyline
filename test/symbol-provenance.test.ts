import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type {
  AgentEvidenceBundle,
  AgentHistoryDiscoveryContext,
  AgentHistoryDiscoveryResult,
  AgentHistorySource,
  AgentSessionRef,
  AgentSessionSummary,
  AgentSummaryRelevanceScan,
} from "../src/agents/agent-history-source.js";
import { GitProcess, type GitRunner } from "../src/git/git-process.js";
import { analyzeRange } from "../src/provenance/explain-range.js";
import { analyzeSymbol } from "../src/provenance/explain-symbol.js";
import { OperationalError } from "../src/whyline-error.js";

const execFileAsync = promisify(execFile);

class EmptyHistorySource implements AgentHistorySource {
  public readonly id = "empty";

  public async *discover(_context?: AgentHistoryDiscoveryContext): AsyncIterable<AgentSessionRef> {
    return;
  }

  public discoverWithDiagnostics(
    _context?: AgentHistoryDiscoveryContext,
  ): Promise<AgentHistoryDiscoveryResult> {
    return Promise.resolve({ availability: "available", refs: [], diagnostics: [], namespaceSignature: "empty" });
  }

  public scanSummaryAndRelevance(_ref: AgentSessionRef): Promise<AgentSummaryRelevanceScan> {
    return Promise.reject(new Error("no refs"));
  }

  public readSummary(_ref: AgentSessionRef): Promise<AgentSessionSummary> {
    return Promise.reject(new Error("no refs"));
  }

  public extractEvidence(_ref: AgentSessionRef): Promise<AgentEvidenceBundle> {
    return Promise.reject(new Error("no refs"));
  }
}

interface Fixture {
  readonly directory: string;
  readonly runner: GitProcess;
}

async function makeFixture(t: test.TestContext): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-symbol-flow-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const globalConfig = path.join(directory, "empty-gitconfig");
  await writeFile(globalConfig, "", "utf8");
  const runner = new GitProcess({
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
    ["config", "user.name", "Whyline Symbol"],
    ["config", "user.email", "symbol@example.test"],
  ] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }
  return { directory, runner };
}

async function runGit(fixture: Fixture, args: readonly string[]): Promise<void> {
  const result = await fixture.runner.run(args, { cwd: fixture.directory });
  assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
}

test("symbol analysis delegates one exact range to the existing engine", async (t) => {
  const fixture = await makeFixture(t);
  const file = path.join(fixture.directory, "src", "parser.ts");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "export function parseToken() {\n  return true;\n}\n", "utf8");
  await runGit(fixture, ["add", "--", "src/parser.ts"]);
  await runGit(fixture, ["commit", "--no-verify", "-m", "add parser"]);

  const options = {
    currentDirectory: fixture.directory,
    git: fixture.runner,
    agentHistorySource: new EmptyHistorySource(),
  };
  const symbol = await analyzeSymbol("parseToken", "src/parser.ts", options);
  const explicit = await analyzeRange("src/parser.ts:1-3", options);
  assert.deepEqual(symbol.range, explicit);
  assert.equal(symbol.symbol.qualifiedName, "parseToken");
  assert.equal(symbol.range.location.startLine, 1);
  assert.equal(symbol.range.location.endLine, 3);
});

test("untracked symbols use current contents and retain line-specific worktree analysis", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.directory, "README.md"), "fixture\n", "utf8");
  await runGit(fixture, ["add", "--", "README.md"]);
  await runGit(fixture, ["commit", "--no-verify", "-m", "fixture"]);
  const file = path.join(fixture.directory, "src", "untracked.ts");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "export const parseToken = () => true;\n", "utf8");
  const report = await analyzeSymbol("parseToken", "src/untracked.ts", {
    currentDirectory: fixture.directory,
    git: fixture.runner,
    agentHistorySource: new EmptyHistorySource(),
  });
  assert.equal(report.range.location.targetState, "untracked");
  assert.equal(report.range.textualGroups.every((group) => group.state === "uncommitted"), true);
  assert.equal(report.range.correlations.length, 1);
  assert.equal(report.range.correlations[0]?.targetKind, "worktree");
});

test("symbol analysis keeps final source stability verification", async (t) => {
  const fixture = await makeFixture(t);
  const file = path.join(fixture.directory, "src", "parser.ts");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "function parseToken() {}\n", "utf8");
  await runGit(fixture, ["add", "--", "src/parser.ts"]);
  await runGit(fixture, ["commit", "--no-verify", "-m", "add parser"]);

  await assert.rejects(
    analyzeSymbol("parseToken", "src/parser.ts", {
      currentDirectory: fixture.directory,
      git: fixture.runner,
      agentHistorySource: new EmptyHistorySource(),
      hooks: {
        beforeFinalVerification: async () => {
          await writeFile(file, "function parseToken() { return false; }\n", "utf8");
        },
      },
    }),
    (error: unknown) => error instanceof OperationalError
      && error.exitCode === 3
      && error.message === "repository changed during analysis",
  );
});

test("rejects a 201-line symbol before provenance work starts", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.directory, "README.md"), "fixture\n", "utf8");
  await runGit(fixture, ["add", "--", "README.md"]);
  await runGit(fixture, ["commit", "--no-verify", "-m", "fixture"]);
  const file = path.join(fixture.directory, "src", "huge.ts");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    "class Huge {",
    ...Array.from({ length: 199 }, (_value, index) => `  // line ${index + 1}`),
    "}",
  ].join("\n") + "\n", "utf8");
  const calls: readonly (readonly string[])[] = [];
  const recordingRunner: GitRunner = {
    run: async (args, options) => {
      (calls as (readonly string[])[]).push([...args]);
      return fixture.runner.run(args, options);
    },
  };
  await assert.rejects(
    analyzeSymbol("Huge", "src/huge.ts", {
      currentDirectory: fixture.directory,
      git: recordingRunner,
      agentHistorySource: new EmptyHistorySource(),
    }),
    (error: unknown) => error instanceof Error
      && "exitCode" in error
      && error.exitCode === 2
      && error.message.includes("spans 201 lines (1-201)")
      && error.message.includes("current limit is 200 lines"),
  );
  assert.equal(calls.some((args) => args.includes("blame")), false);
  assert.equal(calls.some((args) => args.includes("cat-file")), false);
});

test("compiled CLI accepts symbol summary and details", async (t) => {
  const fixture = await makeFixture(t);
  const file = path.join(fixture.directory, "src", "parser.ts");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "function parseToken() {}\n", "utf8");
  await runGit(fixture, ["add", "--", "src/parser.ts"]);
  await runGit(fixture, ["commit", "--no-verify", "-m", "add parser"]);
  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const result = await execFileAsync(process.execPath, [cliPath, "--symbol", "parseToken", "src/parser.ts"], {
    cwd: fixture.directory,
    env: { ...process.env, CODEX_HOME: path.join(fixture.directory, "codex-home") },
  });
  assert.match(result.stdout, /src\/parser\.ts — parseToken/);
});
