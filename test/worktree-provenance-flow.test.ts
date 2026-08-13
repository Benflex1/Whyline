import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentEvidenceBundle,
  AgentHistorySource,
  AgentSessionRef,
  AgentSessionSummary,
  AgentSourceSignature,
} from "../src/agents/agent-history-source.js";
import { GitProcess } from "../src/git/git-process.js";
import { analyzeLocation } from "../src/provenance/explain-location.js";
import { renderSummary } from "../src/cli/render-summary.js";
import { WhylineError } from "../src/whyline-error.js";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface Fixture {
  readonly directory: string;
  readonly runner: GitProcess;
}

async function runGit(fixture: Fixture, args: readonly string[]): Promise<Buffer> {
  const result = await fixture.runner.run(args, { cwd: fixture.directory });
  assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  return result.stdout;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-worktree-flow-"));
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
  await runGit({ directory, runner }, ["init", "--initial-branch=main"]);
  await runGit({ directory, runner }, ["config", "user.name", "Whyline Worktree"]);
  await runGit({ directory, runner }, ["config", "user.email", "worktree@example.test"]);
  await runGit({ directory, runner }, ["config", "commit.gpgSign", "false"]);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, runner };
}

function sourceFor(
  directory: string,
  lines: readonly string[],
  options: { readonly includePatch?: boolean } = {},
): { readonly source: AgentHistorySource; readonly scanCalls: () => number } {
  const ref: AgentSessionRef = {
    adapterId: "synthetic",
    sourcePath: "/opaque/worktree-session",
    sourceKind: "active",
  };
  const session: AgentSessionSummary = {
    ref,
    sessionId: "worktree-session",
    initialCwd: directory,
    workingDirectories: [directory],
    isPartial: false,
    diagnostics: [],
  };
  const fingerprints = lines.map(digest);
  const bundle: AgentEvidenceBundle = {
    session,
    evidence: options.includePatch === false ? [] : [{
      id: "worktree-patch",
      kind: "patch-result",
      cwd: directory,
      worktreeIdentity: "exact-current-worktree",
      paths: ["src-target.ts"],
      operation: "patch",
      callId: "worktree-call",
      resultRecorded: true,
      reportedSuccess: true,
      patch: {
        callId: "worktree-call",
        reportedSuccess: true,
        changes: [{
          path: "src-target.ts",
          changeType: "update",
          payloadKind: "unified-diff",
          payloadRecovered: true,
          payloadFingerprint: "payload",
          payloadTruncated: false,
          addedLineFingerprints: fingerprints,
          matchLineFingerprints: fingerprints,
          distinctiveLineFingerprints: fingerprints,
          matchSide: "added",
          hunkRanges: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: lines.length }],
          lineCount: lines.length,
          worktreeHunks: [{
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: lines.length,
            matchSide: "added",
            orderedLineFingerprints: fingerprints,
            distinctiveLineFingerprints: fingerprints,
            lineCount: lines.length,
            truncated: false,
          }],
        }],
      },
      commitIds: [],
      extraction: "structured",
      sourceRecord: 10,
    }],
    unknownRecordCount: 0,
    diagnostics: [],
  };
  let scanCount = 0;
  const signature: AgentSourceSignature = { device: 1, inode: 2, size: 3, mtimeNs: 4n };
  const source: AgentHistorySource = {
    id: "synthetic",
    async *discover() { yield ref; },
    async discoverWithDiagnostics() {
      return { availability: "available" as const, refs: [ref], diagnostics: [] };
    },
    async scanSummaryAndRelevance() {
      scanCount += 1;
      return {
        ref,
        summary: session,
        correlationEvidence: { evidence: bundle.evidence, unknownRecordCount: 0 },
        relevanceCoverage: { status: "complete" as const, reasons: [] },
        bytesRead: 0,
        recordsSeen: 1,
        sourceSignature: signature,
      };
    },
    async readSummary() { return session; },
    async extractEvidence() { return bundle; },
    async verifySourceSignature(_ref, _expected) { return true; },
  };
  return { source, scanCalls: () => scanCount };
}

test("single changed line receives a worktree correlation result", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "src-target.ts"), "baseline\n", "utf8");
  await runGit(f, ["add", "--", "src-target.ts"]);
  await runGit(f, ["commit", "--no-verify", "-m", "baseline"]);
  const first = "const singleLineWorktreeAlpha = \"alpha-value\";";
  const second = "const singleLineWorktreeBeta = \"beta-value\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${first}\n${second}\n`, "utf8");
  const synthetic = sourceFor(f.directory, [first, second]);
  const report = await analyzeLocation("src-target.ts:1", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: synthetic.source,
  });
  assert.equal(report.provenance.state, "uncommitted");
  assert.equal(report.ancestry, undefined);
  assert.equal(report.correlation, undefined);
  assert.equal(report.worktreeCorrelation?.status, "matched");
  assert.equal(synthetic.scanCalls(), 1);
  const summary = renderSummary(report);
  assert.match(summary, /uncommitted; modified against HEAD [0-9a-f]{7}/);
  assert.match(summary, /Git ancestry: not run for an uncommitted line/);
  assert.match(summary, /likely Codex session/);
  assert.doesNotMatch(summary, /patch-source|worktree-session.*jsonl|\/tmp/);
});

test("insufficient worktree material stops before Codex discovery", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "src-target.ts"), "return;\n", "utf8");
  await runGit(f, ["add", "--", "src-target.ts"]);
  await runGit(f, ["commit", "--no-verify", "-m", "baseline"]);
  await writeFile(path.join(f.directory, "src-target.ts"), "throw;\n", "utf8");
  const synthetic = sourceFor(f.directory, ["throw;"], { includePatch: false });
  const report = await analyzeLocation("src-target.ts:1", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: synthetic.source,
  });
  assert.equal(report.provenance.state, "uncommitted");
  assert.equal(report.worktreeCorrelation?.status, "insufficient");
  assert.equal(synthetic.scanCalls(), 0);
  assert.match(renderSummary(report), /worktree material is insufficient/);
});

test("closing stability rejects changed current content and ignores stage-only changes", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "src-target.ts"), "baseline\n", "utf8");
  await runGit(f, ["add", "--", "src-target.ts"]);
  await runGit(f, ["commit", "--no-verify", "-m", "baseline"]);
  const first = "const stabilityWorktreeAlpha = \"alpha-value\";";
  const second = "const stabilityWorktreeBeta = \"beta-value\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${first}\n${second}\n`, "utf8");

  const staged = sourceFor(f.directory, [first, second]);
  const stagedReport = await analyzeLocation("src-target.ts:1", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: staged.source,
    hooks: {
      beforeFinalVerification: async () => {
        await runGit(f, ["add", "--", "src-target.ts"]);
      },
    },
  });
  assert.equal(stagedReport.worktreeCorrelation?.status, "matched");

  const changed = sourceFor(f.directory, [first, second]);
  await assert.rejects(
    () => analyzeLocation("src-target.ts:1", {
      currentDirectory: f.directory,
      git: f.runner,
      agentHistorySource: changed.source,
      hooks: {
        beforeFinalVerification: async () => {
          await writeFile(path.join(f.directory, "src-target.ts"), "changed-after-analysis\n", "utf8");
        },
      },
    }),
    (error: unknown) => error instanceof WhylineError && error.exitCode === 3,
  );
});
