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
import { GitProcess } from "../src/git/git-process.js";
import { analyzeRange } from "../src/provenance/explain-range.js";

class EmptySource implements AgentHistorySource {
  public readonly id = "empty";
  public async *discover(_context?: AgentHistoryDiscoveryContext): AsyncIterable<AgentSessionRef> {}
  public async discoverWithDiagnostics(): Promise<AgentHistoryDiscoveryResult> {
    return { availability: "available", refs: [], diagnostics: [] };
  }
  public async scanSummaryAndRelevance(_ref: AgentSessionRef): Promise<AgentSummaryRelevanceScan> {
    throw new Error("no sessions");
  }
  public async readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary> {
    throw new Error(ref.sourcePath);
  }
  public async extractEvidence(ref: AgentSessionRef): Promise<AgentEvidenceBundle> {
    throw new Error(ref.sourcePath);
  }
}

test("dirty range analysis keeps separate current-side worktree groups", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-worktree-range-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "gitconfig");
  await writeFile(config, "", "utf8");
  const runner = new GitProcess({
    environment: {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
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
  await mkdir(path.join(directory, "src"), { recursive: true });
  const baseline = [
    "const stableOne = \"one\";",
    "const oldTwo = \"two\";",
    "const stableThree = \"three\";",
    "const oldFour = \"four\";",
  ];
  await writeFile(path.join(directory, "src/range.ts"), baseline.join("\n") + "\n", "utf8");
  for (const args of [["add", "--", "src/range.ts"], ["commit", "--no-verify", "-m", "baseline"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }
  const current = [...baseline];
  current[1] = "const worktreeAlphaAnchor = \"alpha-value-with-material\";";
  current[3] = "const worktreeBetaAnchor = \"beta-value-with-material\";";
  await writeFile(path.join(directory, "src/range.ts"), current.join("\n") + "\n", "utf8");

  const report = await analyzeRange("src/range.ts:1-4", {
    currentDirectory: directory,
    git: runner,
    agentHistorySource: new EmptySource(),
  });
  const worktreeGroups = report.correlations.filter((group) => group.targetKind === "worktree");
  assert.equal(worktreeGroups.length, 2);
  assert.deepEqual(worktreeGroups.map((group) => group.spans), [
    [{ startLine: 2, endLine: 2 }],
    [{ startLine: 4, endLine: 4 }],
  ]);
});

