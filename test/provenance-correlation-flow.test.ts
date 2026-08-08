import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentEvidenceBundle,
  AgentHistoryDiscoveryContext,
  AgentHistoryDiscoveryResult,
  AgentHistorySource,
  AgentEvidenceTarget,
  AgentSessionRef,
  AgentSessionSummary,
} from "../src/agents/agent-history-source.js";
import { GitProcess } from "../src/git/git-process.js";
import { analyzeLocation } from "../src/provenance/explain-location.js";
import type { WhylineReport } from "../src/provenance/model.js";

function digestLine(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

interface Fixture {
  readonly directory: string;
  readonly runner: GitProcess;
}

async function runGit(
  fixture: Fixture,
  args: readonly string[],
): Promise<Buffer> {
  const result = await fixture.runner.run(args, {
    cwd: fixture.directory,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString("utf8"));
  }
  return result.stdout;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-correlation-flow-"));
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
  await runGit({ directory, runner }, ["config", "user.name", "Whyline Fixture"]);
  await runGit({ directory, runner }, ["config", "user.email", "whyline@example.test"]);
  await runGit({ directory, runner }, ["config", "commit.gpgSign", "false"]);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, runner };
}

async function commitTarget(fixtureValue: Fixture): Promise<string> {
  await runGit(fixtureValue, ["add", "--", "src-target.ts"]);
  await runGit(fixtureValue, ["commit", "--no-verify", "-m", "add target"]);
  return (await runGit(fixtureValue, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

function reference(
  fixtureValue: Fixture,
  sessionId = "synthetic-session",
): AgentSessionRef {
  return {
    adapterId: "fake",
    sourcePath: path.join(fixtureValue.directory, "synthetic-home", `${sessionId}.jsonl`),
    sourceKind: "active",
  };
}

function summary(
  ref: AgentSessionRef,
  cwd: string,
  commitHash: string,
): AgentSessionSummary {
  return {
    ref,
    sessionId: "synthetic-session",
    startedAt: "2026-08-08T00:00:00.000Z",
    observedThroughAt: "2026-08-08T00:30:00.000Z",
    initialCwd: cwd,
    workingDirectories: [cwd],
    transcriptGit: { commitHash, referenceKind: "session-head" },
    isPartial: false,
    diagnostics: [],
  };
}

function evidence(
  session: AgentSessionSummary,
  lines: readonly string[],
  targetPath = "src-target.ts",
): AgentEvidenceBundle {
  const fingerprints = lines.map(digestLine);
  return {
    session,
    evidence: [{
      id: "evidence-patch",
      kind: "patch-result",
      occurredAt: "2026-08-08T00:15:00.000Z",
      cwd: session.initialCwd,
      paths: [targetPath],
      operation: "patch",
      callId: "patch-1",
      resultRecorded: true,
      reportedSuccess: true,
      patch: {
        callId: "patch-1",
        reportedSuccess: true,
        changes: [{
          path: targetPath,
          changeType: "update",
          payloadKind: "unified-diff",
          payloadRecovered: true,
          payloadFingerprint: "opaque-payload",
          payloadTruncated: false,
          addedLineFingerprints: fingerprints,
          matchLineFingerprints: fingerprints,
          distinctiveLineFingerprints: fingerprints,
          matchSide: "added",
          hunkRanges: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }],
          lineCount: 2,
        }],
      },
      commitIds: [],
      extraction: "structured",
      sourceRecord: 10,
    }],
    unknownRecordCount: 0,
    diagnostics: [],
  };
}

class FakeAgentHistorySource implements AgentHistorySource {
  public readonly id = "fake";
  public discoverCalls = 0;
  public discoveryContexts: AgentHistoryDiscoveryContext[] = [];
  public summaryCalls = 0;
  public extractionCalls = 0;
  public extractionTargets: (AgentEvidenceTarget | undefined)[] = [];

  public constructor(
    private readonly sessionSummary: AgentSessionSummary,
    private readonly bundle: AgentEvidenceBundle,
  ) {}

  public async *discover(): AsyncIterable<AgentSessionRef> {
    this.discoverCalls += 1;
    throw new Error("legacy discover must not replace explicit diagnostics discovery");
  }

  public async discoverWithDiagnostics(
    context?: AgentHistoryDiscoveryContext,
  ): Promise<AgentHistoryDiscoveryResult> {
    this.discoveryContexts.push(context ?? {});
    return {
      availability: "available",
      refs: [this.sessionSummary.ref],
      diagnostics: [],
    };
  }

  public async readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary> {
    this.summaryCalls += 1;
    assert.equal(ref.sourcePath, this.sessionSummary.ref.sourcePath);
    return this.sessionSummary;
  }

  public async extractEvidence(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ): Promise<AgentEvidenceBundle> {
    this.extractionCalls += 1;
    this.extractionTargets.push(target);
    assert.equal(ref.sourcePath, this.sessionSummary.ref.sourcePath);
    return this.bundle;
  }
}

function assertNoCorrelationCalls(source: FakeAgentHistorySource): void {
  assert.equal(source.discoverCalls, 0);
  assert.equal(source.summaryCalls, 0);
  assert.equal(source.extractionCalls, 0);
  assert.deepEqual(source.discoveryContexts, []);
}

test("uncommitted lines return before Codex discovery", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "src-target.ts"), "original\n", "utf8");
  await runGit(f, ["add", "--", "src-target.ts"]);
  await runGit(f, ["commit", "--no-verify", "-m", "baseline"]);
  await writeFile(path.join(f.directory, "src-target.ts"), "locally edited\n", "utf8");

  const ref = reference(f);
  const session = summary(ref, f.directory, "0123456789012345678901234567890123456789");
  const source = new FakeAgentHistorySource(session, evidence(session, ["unused", "unused"]));
  const report = await analyzeLocation("src-target.ts:1", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.provenance.state, "uncommitted");
  assert.equal(report.correlation, undefined);
  assertNoCorrelationCalls(source);
});

test("untracked lines return before Codex discovery", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "baseline.ts"), "baseline\n", "utf8");
  await runGit(f, ["add", "--", "baseline.ts"]);
  await runGit(f, ["commit", "--no-verify", "-m", "baseline"]);
  await writeFile(path.join(f.directory, "new.ts"), "new line\n", "utf8");

  const ref = reference(f);
  const session = summary(ref, f.directory, "0123456789012345678901234567890123456789");
  const source = new FakeAgentHistorySource(session, evidence(session, ["unused", "unused"]));
  const report = await analyzeLocation("new.ts:1", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
  });

  assert.equal(report.provenance.state, "uncommitted");
  assert.equal(report.correlation, undefined);
  assertNoCorrelationCalls(source);
});

test("committed provenance passes a narrow target hint and normalized correlation", async (t) => {
  const f = await fixture(t);
  const firstLine = "const firstSignal = \"alpha\";";
  const secondLine = "const secondSignal = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);

  const ref = reference(f);
  const session = summary(ref, f.directory, commit);
  const source = new FakeAgentHistorySource(session, evidence(session, [firstLine, secondLine]));
  const syntheticHome = path.join(f.directory, "synthetic-home");
  const report: WhylineReport = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: syntheticHome,
  });

  assert.equal(report.provenance.state, "committed");
  assert.equal(report.provenance.commit?.id, commit);
  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.session.sessionId, "synthetic-session");
  assert.equal(source.summaryCalls, 1);
  assert.equal(source.extractionCalls, 1);
  assert.deepEqual(source.discoveryContexts, [{ historyRoot: syntheticHome }]);
  assert.deepEqual(source.extractionTargets, [{
    repositoryPath: "src-target.ts",
    line: 2,
    worktreeRoot: f.directory,
  }]);
  const targetHint = source.extractionTargets[0];
  assert.ok(targetHint !== undefined);
  assert.equal("commit" in targetHint, false);
  assert.equal("relevantHunks" in targetHint, false);
  assert.equal("evidence" in targetHint, false);
});
