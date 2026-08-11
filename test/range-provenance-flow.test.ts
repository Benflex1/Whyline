import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import type { WhylineRangeReport } from "../src/provenance/range-model.js";

interface Fixture {
  readonly directory: string;
  readonly runner: GitProcess;
}

class EmptyHistorySource implements AgentHistorySource {
  public readonly id = "empty";
  public discoverCalls = 0;
  public scanCalls = 0;

  public async *discover(_context?: AgentHistoryDiscoveryContext): AsyncIterable<AgentSessionRef> {
    return;
  }

  public discoverWithDiagnostics(
    _context?: AgentHistoryDiscoveryContext,
  ): Promise<AgentHistoryDiscoveryResult> {
    this.discoverCalls += 1;
    return Promise.resolve({
      availability: "available",
      refs: [],
      diagnostics: [],
      namespaceSignature: "empty",
    });
  }

  public scanSummaryAndRelevance(_ref: AgentSessionRef): Promise<AgentSummaryRelevanceScan> {
    this.scanCalls += 1;
    return Promise.reject(new Error("no refs"));
  }

  public readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary> {
    return Promise.reject(new Error("no refs: " + ref.sourcePath));
  }

  public extractEvidence(ref: AgentSessionRef): Promise<AgentEvidenceBundle> {
    return Promise.reject(new Error("no refs: " + ref.sourcePath));
  }
}

async function makeFixture(t: test.TestContext): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-range-flow-"));
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
    ["config", "user.name", "Whyline Range"],
    ["config", "user.email", "range@example.test"],
  ] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }
  return { directory, runner };
}

async function runGit(fixture: Fixture, args: readonly string[]): Promise<string> {
  const result = await fixture.runner.run(args, { cwd: fixture.directory });
  assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  return result.stdout.toString("utf8").trim();
}

async function writeTarget(fixture: Fixture, lines: readonly string[]): Promise<void> {
  await mkdir(path.join(fixture.directory, "src"), { recursive: true });
  await writeFile(path.join(fixture.directory, "src/flow.ts"), lines.join("\n") + "\n", "utf8");
}

test("keeps committed and uncommitted groups independent with one baseline range blame", async (t) => {
  const fixture = await makeFixture(t);
  const source = new EmptyHistorySource();
  await writeTarget(fixture, [
    "const committedOne = \"one\";",
    "const committedTwo = \"two\";",
    "const dirtyThree = \"three\";",
    "const committedFour = \"four\";",
  ]);
  await runGit(fixture, ["add", "--", "src/flow.ts"]);
  await runGit(fixture, ["commit", "--no-verify", "-m", "flow base"]);
  await writeTarget(fixture, [
    "const committedOne = \"one\";",
    "const committedTwo = \"two\";",
    "const dirtyThree = \"locally changed\";",
    "const committedFour = \"four\";",
  ]);

  const calls: readonly (readonly string[])[] = [];
  const recordingRunner: GitRunner = {
    run: async (args, options) => {
      (calls as (readonly string[])[]).push([...args]);
      return fixture.runner.run(args, options);
    },
  };
  const report = await analyzeRange("src/flow.ts:1-4", {
    currentDirectory: fixture.directory,
    git: recordingRunner,
    agentHistorySource: source,
  });

  assert.equal(report.lineAttributions.length, 4);
  assert.equal(report.textualGroups.some((group) => group.state === "uncommitted"), true);
  const dirtyGroup = report.textualGroups.find((group) => group.state === "uncommitted");
  assert.ok(dirtyGroup);
  if (dirtyGroup === undefined) return;
  assert.equal(report.correlations.some((group) => group.groupId === dirtyGroup.id), false);
  assert.equal(source.scanCalls, 0);
  assert.equal(calls.filter((args) =>
    args.includes("blame") && args.includes("--line-porcelain") && !args.includes("-M")).length, 1);
});

test("marks committed groups after the deep-analysis bound as work-bound", async (t) => {
  const fixture = await makeFixture(t);
  const source = new EmptyHistorySource();
  const lines: string[] = [];
  for (let index = 1; index <= 25; index += 1) {
    lines.push("const separateGroup" + index + " = \"value-" + index + "\";");
    await writeTarget(fixture, lines);
    await runGit(fixture, ["add", "--", "src/flow.ts"]);
    await runGit(fixture, ["commit", "--no-verify", "-m", "group " + index]);
  }

  const report: WhylineRangeReport = await analyzeRange("src/flow.ts:1-25", {
    currentDirectory: fixture.directory,
    git: fixture.runner,
    agentHistorySource: source,
  });

  assert.equal(report.textualGroups.length, 25);
  assert.equal(report.coverage.deepAnalyzedGroups, 24);
  assert.equal(report.coverage.workBoundGroups, 1);
  const last = report.textualGroups[24];
  assert.ok(last);
  if (last === undefined) return;
  const lastCorrelation = report.correlations.find((group) => group.groupId === last.id);
  assert.equal(lastCorrelation?.status, "work-bound");
  const lastAncestry = report.ancestry.get(last.id);
  assert.equal(lastAncestry?.segments.every((segment) => segment.status === "work-bound"), true);
});

test("final range stability verification rejects target mutation", async (t) => {
  const fixture = await makeFixture(t);
  const source = new EmptyHistorySource();
  await writeTarget(fixture, ["const stable = true;"]);
  await runGit(fixture, ["add", "--", "src/flow.ts"]);
  await runGit(fixture, ["commit", "--no-verify", "-m", "stable"]);

  await assert.rejects(
    analyzeRange("src/flow.ts:1-1", {
      currentDirectory: fixture.directory,
      git: fixture.runner,
      agentHistorySource: source,
      hooks: {
        beforeFinalVerification: async () => {
          await writeTarget(fixture, ["const stable = false;"]);
        },
      },
    }),
    (error: unknown) => error instanceof Error && error.message === "repository changed during analysis",
  );
});
