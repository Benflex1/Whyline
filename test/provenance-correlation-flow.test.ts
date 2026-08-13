import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentCorrelationEvidenceProjection,
  AgentDiagnostic,
  AgentEvidence,
  AgentEvidenceBundle,
  AgentHistoryAvailability,
  AgentHistoryDiscoveryContext,
  AgentHistoryDiscoveryResult,
  AgentHistorySource,
  AgentEvidenceTarget,
  AgentSourceSignature,
  AgentSessionRef,
  AgentSessionSummary,
} from "../src/agents/agent-history-source.js";
import { CodexHistorySource } from "../src/agents/codex/source.js";
import { classifyStrongPossibility } from "../src/correlation/build-candidates.js";
import { GitProcess } from "../src/git/git-process.js";
import { discoverRepositoryContext } from "../src/git/repository-context.js";
import { prepareCodexEvidence, projectPreparedCodex } from "../src/provenance/correlate-codex.js";
import type { ResolvedCodeLocation } from "../src/provenance/model.js";
import type { WorktreeCorrelationTarget } from "../src/correlation/model.js";
import { analyzeLocation } from "../src/provenance/explain-location.js";
import { CorrelationTelemetry, FIXED_METRIC_NAMES } from "../src/provenance/correlation-telemetry.js";
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
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "whyline-correlation-flow-")));
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

async function commitPath(
  fixtureValue: Fixture,
  repositoryPath: string,
): Promise<string> {
  await runGit(fixtureValue, ["add", "--", repositoryPath]);
  await runGit(fixtureValue, ["commit", "--no-verify", "-m", "add path"]);
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
  overrides: Partial<AgentSessionSummary> = {},
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
    ...overrides,
  };
}

function evidence(
  session: AgentSessionSummary,
  lines: readonly string[],
  targetPath = "src-target.ts",
  diagnostics: readonly AgentDiagnostic[] = [],
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
          worktreeHunks: [{
            oldStart: 0,
            oldLines: 0,
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
    diagnostics,
  };
}

function evidenceWithoutCwd(bundle: AgentEvidenceBundle): AgentEvidenceBundle {
  return {
    ...bundle,
    evidence: bundle.evidence.map((value) => {
      const result = { ...value };
      delete result.cwd;
      return result;
    }),
  };
}

function worktreeTarget(
  repository: Awaited<ReturnType<typeof discoverRepositoryContext>>,
  lines: readonly string[],
): WorktreeCorrelationTarget {
  const fingerprints = lines.map(digestLine);
  const alphanumeric = lines.map((line) => [...line].filter((value) => /[A-Za-z0-9]/.test(value)).length);
  const hunk = {
    oldPath: "src-target.ts",
    newPath: "src-target.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: lines.length,
    targetLineKind: "added" as const,
    addedLineFingerprints: fingerprints,
    deletedLineFingerprints: [],
    distinctiveAddedLineFingerprints: fingerprints,
    distinctiveDeletedLineFingerprints: [],
    truncated: false,
    basis: "derived" as const,
    operation: "update" as const,
    queriedSpans: [{ startLine: 1, endLine: lines.length }],
    currentLineFingerprints: fingerprints,
    currentDistinctiveLineFingerprints: fingerprints,
    currentLineAlphanumericCounts: alphanumeric,
    complete: true as const,
  };
  return {
    kind: "worktree",
    basis: "derived",
    repository: {
      worktreeRoot: repository.worktreeRoot,
      gitDir: repository.gitDir,
      commonGitDir: repository.commonGitDir,
      objectFormat: repository.objectFormat,
      worktrees: repository.worktrees.map((value) => ({
        path: value.path,
        commonGitDir: repository.commonGitDir,
      })),
    },
    baseCommitId: repository.headCommit,
    targetPath: "src-target.ts",
    changeKind: "modified",
    staging: "unstaged",
    queriedSpans: [{ startLine: 1, endLine: lines.length }],
    relevantHunks: [hunk],
    targetSnapshot: {
      baseCommitId: repository.headCommit,
      repositoryPath: "src-target.ts",
      changeKind: "modified",
      fileSnapshot: { size: 100, mtimeMs: 1, ino: 2, dev: 3, digest: "current" },
      evidenceDigest: "current-evidence",
    },
  };
}

interface RealCodexPatchTranscriptOptions {
  readonly sessionId: string;
  readonly commitHash: string;
  readonly sessionCwd?: string;
  readonly contextCwds?: readonly string[];
  readonly patchPath: string;
  readonly firstLine: string;
  readonly secondLine: string;
}

async function writeRealCodexPatchTranscript(
  codexHome: string,
  options: RealCodexPatchTranscriptOptions,
): Promise<void> {
  const transcriptPath = path.join(
    codexHome,
    "sessions",
    "2026",
    "08",
    "08",
    `${options.sessionId}.jsonl`,
  );
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  const sessionPayload: Record<string, unknown> = {
    session_id: options.sessionId,
    timestamp: "2026-08-08T01:34:54.000Z",
    git: { commit_hash: options.commitHash },
  };
  if (options.sessionCwd !== undefined) {
    sessionPayload.cwd = options.sessionCwd;
  }
  const records: unknown[] = [{
    timestamp: "2026-08-08T01:34:54.000Z",
    type: "session_meta",
    payload: sessionPayload,
  }];
  for (const [index, cwd] of (options.contextCwds ?? []).entries()) {
    records.push({
      timestamp: `2026-08-08T01:34:${String(55 + index).padStart(2, "0")}.000Z`,
      type: "turn_context",
      payload: { cwd },
    });
  }
  records.push({
    timestamp: "2026-08-08T01:35:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: `${options.sessionId}-patch-call`,
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: src-target.ts\n*** End Patch",
    },
  });
  records.push({
    timestamp: "2026-08-08T01:35:01.000Z",
    type: "event_msg",
    payload: {
      type: "patch_apply_end",
      call_id: `${options.sessionId}-patch-call`,
      status: "completed",
      success: true,
      changes: {
        [options.patchPath]: {
          type: "update",
          unified_diff: [
            "@@ -0,0 +1,2 @@",
            `+${options.firstLine}`,
            `+${options.secondLine}`,
          ].join("\n"),
        },
      },
    },
  });
  await writeFile(
    transcriptPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

interface FakeAgentHistoryOptions {
  readonly availability?: AgentHistoryAvailability;
  readonly diagnostics?: readonly AgentDiagnostic[];
  readonly sourceSignature?: AgentSourceSignature | null;
}

class FakeAgentHistorySource implements AgentHistorySource {
  public readonly id = "fake";
  public discoverCalls = 0;
  public scanCalls = 0;
  public scannedRefPaths: string[] = [];
  public scannedSessionIds: (string | null)[] = [];
  public scanTargets: (AgentEvidenceTarget | undefined)[] = [];
  public discoveryContexts: AgentHistoryDiscoveryContext[] = [];
  public summaryCalls = 0;
  public extractionCalls = 0;
  public extractionTargets: (AgentEvidenceTarget | undefined)[] = [];
  private readonly summaries: readonly AgentSessionSummary[];
  private readonly bundles: ReadonlyMap<string, AgentEvidenceBundle>;

  public constructor(
    sessionSummary: AgentSessionSummary | readonly AgentSessionSummary[],
    bundle: AgentEvidenceBundle | readonly AgentEvidenceBundle[],
    private readonly options: FakeAgentHistoryOptions = {},
  ) {
    this.summaries = Array.isArray(sessionSummary) ? sessionSummary : [sessionSummary];
    const bundles = Array.isArray(bundle) ? bundle : this.summaries.map(() => bundle);
    assert.equal(bundles.length, this.summaries.length);
    this.bundles = new Map(this.summaries.map((value, index) => [value.ref.sourcePath, bundles[index]!]));
  }

  public async *discover(): AsyncIterable<AgentSessionRef> {
    this.discoverCalls += 1;
    throw new Error("legacy discover must not replace explicit diagnostics discovery");
  }

  public async discoverWithDiagnostics(
    context?: AgentHistoryDiscoveryContext,
  ): Promise<AgentHistoryDiscoveryResult> {
    this.discoveryContexts.push(context ?? {});
    return {
      availability: this.options.availability ?? "available",
      refs: this.summaries.map((value) => value.ref),
      diagnostics: this.options.diagnostics ?? [],
    };
  }

  public async scanSummaryAndRelevance(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ) {
    this.scanCalls += 1;
    const summaryValue = this.summaries.find((summaryValue) => summaryValue.ref.sourcePath === ref.sourcePath);
    assert.ok(summaryValue !== undefined);
    const bundle = this.bundles.get(ref.sourcePath);
    assert.ok(bundle !== undefined);
    this.scannedRefPaths.push(ref.sourcePath);
    this.scannedSessionIds.push(bundle.session.sessionId);
    this.scanTargets.push(target);
    const sessionValue = {
      ...bundle.session,
      diagnostics: [...summaryValue.diagnostics, ...bundle.diagnostics],
    };
    const relevanceReasons = bundle.diagnostics.flatMap((value) => {
      switch (value.kind) {
        case "changed-during-read": return ["changed-during-read" as const];
        case "partial-final-record": return ["partial-record" as const];
        case "corrupt-non-final-record": return ["corrupt-record" as const];
        case "compacted-history":
        case "context-compaction": return ["material-compaction" as const];
        case "thread-rollback":
        case "turn-aborted": return ["material-rollback-or-abort" as const];
        default: return [] as const;
      }
    });
    return {
      ref,
      summary: sessionValue,
      correlationEvidence: {
        evidence: bundle.evidence.filter((value) =>
          value.kind === "patch-attempt"
            || value.kind === "patch-result"
            || value.kind === "git-revision-reference"),
        unknownRecordCount: bundle.unknownRecordCount,
      },
      relevanceCoverage: {
        status: relevanceReasons.length === 0 ? "complete" as const : "limited" as const,
        reasons: relevanceReasons,
      },
      bytesRead: 0,
      recordsSeen: 0,
      sourceSignature: this.options.sourceSignature ?? null,
    };
  }

  public async verifySourceSignature(
    _ref: AgentSessionRef,
    _signature: AgentSourceSignature,
  ): Promise<boolean> {
    return true;
  }

  public async readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary> {
    this.summaryCalls += 1;
    const value = this.summaries.find((summaryValue) => summaryValue.ref.sourcePath === ref.sourcePath);
    assert.ok(value !== undefined);
    return value;
  }

  public async extractEvidence(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ): Promise<AgentEvidenceBundle> {
    this.extractionCalls += 1;
    this.extractionTargets.push(target);
    const value = this.bundles.get(ref.sourcePath);
    assert.ok(value !== undefined);
    return value;
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
  const telemetry = new CorrelationTelemetry();
  const report: WhylineReport = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: syntheticHome,
    correlationTelemetry: telemetry,
  });

  assert.equal(report.provenance.state, "committed");
  assert.equal(report.provenance.commit?.id, commit);
  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.session.sessionId, "synthetic-session");
  assert.equal(report.correlation?.selected?.repositoryMatch, "current-worktree");
  assert.equal(source.scanCalls, 1);
  assert.equal(source.summaryCalls, 0);
  assert.equal(source.extractionCalls, 0);
  assert.deepEqual(source.discoveryContexts, [{ historyRoot: syntheticHome }, { historyRoot: syntheticHome }]);
  assert.deepEqual(source.scanTargets, [{
    repositoryPath: "src-target.ts",
    line: 2,
    worktreeRoot: f.directory,
  }]);
  const targetHint = source.scanTargets[0];
  assert.ok(targetHint !== undefined);
  assert.equal("commit" in targetHint, false);
  assert.equal("relevantHunks" in targetHint, false);
  assert.equal("evidence" in targetHint, false);
  const serializedCorrelation = JSON.stringify(report.correlation);
  assert.equal(serializedCorrelation.includes(f.directory), false);
  assert.equal(serializedCorrelation.includes("synthetic-home"), false);
  const snapshot = telemetry.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), [...FIXED_METRIC_NAMES].sort());
  assert.equal(Object.values(snapshot).every((value) => typeof value === "number"), true);
  assert.equal(snapshot["whyline.correlation.potentially_strong"], 1);
  assert.equal(snapshot["whyline.correlation.full_evidence.candidates"], 1);
  assert.equal(JSON.stringify(snapshot).includes(f.directory), false);
  assert.equal(JSON.stringify(snapshot).includes("synthetic-home"), false);
});

test("real Codex adapter preserves deleted historical cwd for a cwd-less patch result", async (t) => {
  const f = await fixture(t);
  const firstLine = "const realHistoricalFirst = \"alpha\";";
  const secondLine = "const realHistoricalSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);

  const historicalParent = await mkdtemp(path.join(os.tmpdir(), "whyline-real-historical-"));
  const historicalCwd = path.join(historicalParent, "deleted-worktree");
  await mkdir(historicalCwd, { recursive: true });
  await rm(historicalCwd, { recursive: true, force: true });
  t.after(async () => rm(historicalParent, { recursive: true, force: true }));

  const codexHome = path.join(f.directory, "synthetic-codex-home");
  const transcriptPath = path.join(
    codexHome,
    "sessions",
    "2026",
    "08",
    "08",
    "rollout-real-historical.jsonl",
  );
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  const records = [
    {
      timestamp: "2026-08-08T01:34:54.000Z",
      type: "session_meta",
      payload: {
        session_id: "real-deleted-historical",
        timestamp: "2026-08-08T01:34:54.000Z",
        cwd: historicalCwd,
        git: { commit_hash: commit },
      },
    },
    {
      timestamp: "2026-08-08T01:34:55.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "call-real-historical-patch",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src-target.ts\n*** End Patch",
      },
    },
    {
      timestamp: "2026-08-08T01:34:56.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "call-real-historical-patch",
        status: "completed",
        success: true,
        changes: {
          [path.join(historicalCwd, "src-target.ts")]: {
            type: "update",
            unified_diff: [
              "@@ -0,0 +1,2 @@",
              `+${firstLine}`,
              `+${secondLine}`,
            ].join("\n"),
          },
        },
      },
    },
  ];
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const source = new CodexHistorySource();
  const discovery = await source.discoverWithDiagnostics({ historyRoot: codexHome });
  assert.equal(discovery.refs.length, 1);
  const bundle = await source.extractEvidence(discovery.refs[0]!);
  const patchResult = bundle.evidence.find((value) => value.kind === "patch-result");
  assert.equal(bundle.session.initialCwd, historicalCwd);
  assert.equal(patchResult?.cwd, historicalCwd);

  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome,
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.session.sessionId, "real-deleted-historical");
});

test("real Codex adapter attributes a cwd-less patch to the later nested repository cwd", async (t) => {
  const f = await fixture(t);
  const firstLine = "const realNestedFirst = \"alpha\";";
  const secondLine = "const realNestedSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const nestedRepository = path.join(f.directory, "nested-repository");
  await mkdir(nestedRepository, { recursive: true });
  await runGit(f, ["init", "--initial-branch=nested", nestedRepository]);

  const codexHome = path.join(f.directory, "synthetic-codex-home");
  await writeRealCodexPatchTranscript(codexHome, {
    sessionId: "real-nested-cwd",
    commitHash: commit,
    sessionCwd: f.directory,
    contextCwds: [nestedRepository],
    patchPath: path.join(nestedRepository, "src-target.ts"),
    firstLine,
    secondLine,
  });

  const source = new CodexHistorySource();
  const discovery = await source.discoverWithDiagnostics({ historyRoot: codexHome });
  const bundle = await source.extractEvidence(discovery.refs[0]!);
  const patchResult = bundle.evidence.find((value) => value.kind === "patch-result");
  assert.equal(patchResult?.cwd, nestedRepository);
  assert.equal(patchResult?.patch?.changes[0]?.path, "src-target.ts");

  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome,
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(report.correlation?.coverage.usableSummaryRefs, 1);
  assert.equal(report.correlation?.coverage.incompatibleRefs, 0);
});

test("real Codex adapter keeps a cwd-less patch eligible across a linked worktree", async (t) => {
  const f = await fixture(t);
  const firstLine = "const realLinkedFirst = \"alpha\";";
  const secondLine = "const realLinkedSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const linkedParent = await mkdtemp(path.join(os.tmpdir(), "whyline-real-linked-"));
  const linked = path.join(linkedParent, "linked");
  t.after(async () => rm(linkedParent, { recursive: true, force: true }));
  await runGit(f, ["worktree", "add", "--detach", linked, commit]);

  const codexHome = path.join(f.directory, "synthetic-codex-home");
  await writeRealCodexPatchTranscript(codexHome, {
    sessionId: "real-linked-cwd",
    commitHash: commit,
    sessionCwd: f.directory,
    contextCwds: [linked],
    patchPath: path.join(linked, "src-target.ts"),
    firstLine,
    secondLine,
  });

  const source = new CodexHistorySource();
  const discovery = await source.discoverWithDiagnostics({ historyRoot: codexHome });
  const bundle = await source.extractEvidence(discovery.refs[0]!);
  const patchResult = bundle.evidence.find((value) => value.kind === "patch-result");
  assert.equal(patchResult?.cwd, linked);

  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome,
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.session.sessionId, "real-linked-cwd");
});

test("real Codex adapter quarantines a patch when no structured cwd is known", async (t) => {
  const f = await fixture(t);
  const firstLine = "const realUnknownFirst = \"alpha\";";
  const secondLine = "const realUnknownSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const codexHome = path.join(f.directory, "synthetic-codex-home");
  await writeRealCodexPatchTranscript(codexHome, {
    sessionId: "real-unknown-cwd",
    commitHash: commit,
    patchPath: path.join(f.directory, "src-target.ts"),
    firstLine,
    secondLine,
  });

  const source = new CodexHistorySource();
  const discovery = await source.discoverWithDiagnostics({ historyRoot: codexHome });
  const bundle = await source.extractEvidence(discovery.refs[0]!);
  const patchResult = bundle.evidence.find((value) => value.kind === "patch-result");
  assert.equal(patchResult?.cwd, undefined);
  assert.deepEqual(patchResult?.patch?.changes, []);

  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome,
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(report.correlation?.coverage.status, "limited");
  assert.equal(
    report.correlation?.coverage.limitations.some((value) => value.kind === "summary-coverage" && value.material),
    true,
  );
});

test("real adapter mixed evidence keeps valid attribution, rejects mismatch, and quarantines unknown cwd", async (t) => {
  const f = await fixture(t);
  const firstLine = "const realMixedFirst = \"alpha\";";
  const secondLine = "const realMixedSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const nestedRepository = path.join(f.directory, "nested-repository");
  await mkdir(nestedRepository, { recursive: true });
  await runGit(f, ["init", "--initial-branch=nested", nestedRepository]);
  const codexHome = path.join(f.directory, "synthetic-codex-home");
  await writeRealCodexPatchTranscript(codexHome, {
    sessionId: "real-mixed-valid",
    commitHash: commit,
    sessionCwd: f.directory,
    patchPath: path.join(f.directory, "src-target.ts"),
    firstLine,
    secondLine,
  });
  await writeRealCodexPatchTranscript(codexHome, {
    sessionId: "real-mixed-incompatible",
    commitHash: commit,
    sessionCwd: nestedRepository,
    patchPath: path.join(nestedRepository, "src-target.ts"),
    firstLine,
    secondLine,
  });
  await writeRealCodexPatchTranscript(codexHome, {
    sessionId: "real-mixed-unknown",
    commitHash: commit,
    patchPath: path.join(f.directory, "src-target.ts"),
    firstLine,
    secondLine,
  });

  const source = new CodexHistorySource();
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome,
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(
    report.correlation?.alternatives.some((candidate) => candidate.session.sessionId === "real-mixed-valid"),
    true,
  );
  assert.equal(
    report.correlation?.alternatives.some((candidate) => candidate.session.sessionId === "real-mixed-incompatible"),
    false,
  );
  assert.equal(
    report.correlation?.coverage.limitations.some((value) => value.kind === "summary-coverage" && value.material),
    true,
  );
});

test("rebases evidence paths from a nested historical session cwd", async (t) => {
  const f = await fixture(t);
  const firstLine = "const nestedFirstSignal = \"alpha\";";
  const secondLine = "const nestedSecondSignal = \"beta\";";
  await mkdir(path.join(f.directory, "src"), { recursive: true });
  await writeFile(path.join(f.directory, "src", "target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitPath(f, "src/target.ts");

  const ref = reference(f, "nested-cwd");
  const sessionCwd = path.join(f.directory, "src");
  const session = summary(ref, sessionCwd, commit, { sessionId: "nested-cwd" });
  const source = new FakeAgentHistorySource(session, evidence(session, [firstLine, secondLine], "target.ts"));
  const report = await analyzeLocation("src/target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.repositoryMatch, "current-worktree");
  assert.equal(report.correlation?.selected?.signals.some((signal) => signal.kind === "structured-patch-overlap"), true);
});

test("existing nested repository common Git directory overrides worktree containment", async (t) => {
  const f = await fixture(t);
  const firstLine = "const nestedRepoFirstSignal = \"alpha\";";
  const secondLine = "const nestedRepoSecondSignal = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const nestedRepository = path.join(f.directory, "nested-repository");
  await mkdir(nestedRepository, { recursive: true });
  await runGit(f, ["init", "--initial-branch=nested", nestedRepository]);

  const ref = reference(f, "nested-repository");
  const session = summary(ref, nestedRepository, commit, { sessionId: "nested-repository" });
  const source = new FakeAgentHistorySource(session, evidence(session, [firstLine, secondLine]));
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(source.scanCalls, 1);
  assert.equal(source.extractionCalls, 0);
  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.coverage.usableSummaryRefs, 1);
  assert.equal(report.correlation?.coverage.incompatibleRefs, 1);
});

test("a deleted prunable linked worktree remains a linked repository match", async (t) => {
  const f = await fixture(t);
  const firstLine = "linked worktree one";
  const secondLine = "linked worktree two";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const linkedParent = await mkdtemp(path.join(os.tmpdir(), "whyline-prunable-linked-"));
  const linked = path.join(linkedParent, "linked");
  const historicalCwd = path.join(linked, "nested", "deleted", "cwd");
  t.after(async () => rm(linkedParent, { recursive: true, force: true }));
  await runGit(f, ["worktree", "add", "--detach", linked, commit]);
  await rm(linked, { recursive: true, force: true });

  const worktreeList = (await runGit(f, ["worktree", "list", "--porcelain", "-z"])).toString("utf8");
  assert.match(worktreeList, /prunable/);
  const ref = reference(f, "prunable-linked");
  const session = summary(ref, historicalCwd, commit, { sessionId: "prunable-linked" });
  const historicalTargetPath = path.relative(historicalCwd, path.join(linked, "src-target.ts"));
  const source = new FakeAgentHistorySource(
    session,
    evidence(session, [firstLine, secondLine], historicalTargetPath),
  );
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.repositoryMatch, "linked-worktree");
  assert.equal(report.repository.worktrees.some((worktree) => worktree.path === linked && worktree.prunable), true);
});

test("committed correlation preserves availability states", async (t) => {
  const cases: readonly {
    readonly availability: AgentHistoryAvailability;
    readonly status: "none" | "unavailable";
    readonly coverageStatus: "complete" | "limited" | "unavailable";
    readonly limitation: string;
  }[] = [
    { availability: "available", status: "none", coverageStatus: "complete", limitation: "empty-readable-store" },
    { availability: "limited", status: "none", coverageStatus: "limited", limitation: "discovery-limited" },
    { availability: "unavailable", status: "unavailable", coverageStatus: "unavailable", limitation: "discovery-unavailable" },
  ];

  for (const row of cases) {
    const f = await fixture(t);
    await writeFile(path.join(f.directory, "src-target.ts"), "available state\n", "utf8");
    await commitTarget(f);
    const source = new FakeAgentHistorySource([], [], { availability: row.availability });
    const report = await analyzeLocation("src-target.ts:1", {
      currentDirectory: f.directory,
      git: f.runner,
      agentHistorySource: source,
      codexHome: path.join(f.directory, "synthetic-home"),
    });

    assert.equal(report.correlation?.status, row.status, row.availability);
    assert.equal(report.correlation?.coverage.status, row.coverageStatus, row.availability);
    assert.equal(
      report.correlation?.coverage.limitations.some((value) => value.kind === row.limitation),
      true,
      row.availability,
    );
  }
});

test("earlier compaction, rollback, and abort diagnostics do not block direct matches", async (t) => {
  const diagnosticKinds: readonly AgentDiagnostic["kind"][] = [
    "compacted-history",
    "context-compaction",
    "thread-rollback",
    "turn-aborted",
  ];

  for (const diagnosticKind of diagnosticKinds) {
    const f = await fixture(t);
    const firstLine = `diagnostic-${diagnosticKind}-one`;
    const secondLine = `diagnostic-${diagnosticKind}-two`;
    await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
    const commit = await commitTarget(f);
    const ref = reference(f, diagnosticKind);
    const session = summary(ref, f.directory, commit, { sessionId: diagnosticKind });
    const source = new FakeAgentHistorySource(
      session,
      evidence(session, [firstLine, secondLine], "src-target.ts", [{ kind: diagnosticKind, record: 5 }]),
    );
    const report = await analyzeLocation("src-target.ts:2", {
      currentDirectory: f.directory,
      git: f.runner,
      agentHistorySource: source,
      codexHome: path.join(f.directory, "synthetic-home"),
    });

    assert.equal(report.correlation?.status, "matched", diagnosticKind);
    assert.equal(
      report.correlation?.coverage.limitations.some((value) => value.material),
      false,
      diagnosticKind,
    );
  }

  const f = await fixture(t);
  const firstLine = "material diagnostic one";
  const secondLine = "material diagnostic two";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const ref = reference(f, "later-compaction");
  const session = summary(ref, f.directory, commit, { sessionId: "later-compaction" });
  const source = new FakeAgentHistorySource(
    session,
    evidence(session, [firstLine, secondLine], "src-target.ts", [{ kind: "compacted-history", record: 20 }]),
  );
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "none");
  const diagnosticCandidate = report.correlation?.alternatives[0];
  assert.ok(diagnosticCandidate !== undefined);
  assert.equal(diagnosticCandidate.coverageLimitations.some((value) => value.kind === "material-compaction" && value.material), true);
});

test("candidate cap and unresolved repository candidates remain visible in coverage", async (t) => {
  const f = await fixture(t);
  const firstLine = "cap one";
  const secondLine = "cap two";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const summaries = Array.from({ length: 33 }, (_, index) => {
    const id = `cap-${index.toString().padStart(2, "0")}`;
    return summary(reference(f, id), f.directory, commit, { sessionId: id });
  });
  const bundles = summaries.map((value, index) => index === 0
    ? evidence(value, [firstLine, secondLine])
    : evidence(value, [firstLine]));
  const cappedSource = new FakeAgentHistorySource(summaries, bundles);
  const cappedReport = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: cappedSource,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(cappedSource.scanCalls, 33);
  assert.equal(cappedSource.extractionCalls, 0);
  assert.equal(cappedReport.correlation?.status, "none");
  assert.equal(cappedReport.correlation?.coverage.omittedPotentiallyStrongRefs, 1);
  assert.equal(cappedReport.correlation?.coverage.limitations.some((value) => value.kind === "candidate-cap" && value.material), true);

  const matchingRef = reference(f, "matching");
  const matching = summary(matchingRef, f.directory, commit, { sessionId: "matching" });
  const unknownRef = reference(f, "unknown");
  const unknown = summary(unknownRef, path.join(f.directory, "deleted-cwd"), "not-a-commit", {
    sessionId: "unknown",
    initialCwd: path.join(f.directory, "deleted-cwd"),
    workingDirectories: [],
  });
  const unresolvedSource = new FakeAgentHistorySource(
    [matching, unknown],
    [evidence(matching, [firstLine, secondLine]), evidence(unknown, [firstLine, secondLine])],
  );
  const unresolvedReport = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: unresolvedSource,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(unresolvedSource.scanCalls, 2);
  assert.equal(unresolvedSource.extractionCalls, 0);
  assert.equal(unresolvedReport.correlation?.status, "none");
  assert.equal(unresolvedReport.correlation?.coverage.limitations.some((value) => value.kind === "unresolved-repository-candidate" && value.material), true);
});

test("full evidence cwd switching to a nested repository contributes no signals", async (t) => {
  const f = await fixture(t);
  const firstLine = "const nestedEvidenceFirst = \"alpha\";";
  const secondLine = "const nestedEvidenceSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const nestedRepository = path.join(f.directory, "nested-repository");
  await mkdir(nestedRepository, { recursive: true });
  await runGit(f, ["init", "--initial-branch=nested", nestedRepository]);

  const ref = reference(f, "full-nested-cwd");
  const session = summary(ref, f.directory, commit, { sessionId: "full-nested-cwd" });
  const bundle = evidence(session, [firstLine, secondLine]);
  const source = new FakeAgentHistorySource(session, {
    ...bundle,
    session: {
      ...session,
      workingDirectories: [f.directory, nestedRepository],
    },
    evidence: [{
      ...bundle.evidence[0]!,
      cwd: nestedRepository,
    }],
  });
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(
    (report.correlation?.alternatives ?? []).some((candidate) =>
      candidate.signals.some((signal) => signal.kind.startsWith("structured-patch"))),
    false,
  );
});

test("full evidence cwd moving to a linked worktree with the same common directory remains valid", async (t) => {
  const f = await fixture(t);
  const firstLine = "const linkedEvidenceFirst = \"alpha\";";
  const secondLine = "const linkedEvidenceSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const linkedParent = await mkdtemp(path.join(os.tmpdir(), "whyline-full-linked-"));
  const linked = path.join(linkedParent, "linked");
  t.after(async () => rm(linkedParent, { recursive: true, force: true }));
  await runGit(f, ["worktree", "add", "--detach", linked, commit]);

  const ref = reference(f, "full-linked-cwd");
  const summarySession = summary(ref, f.directory, commit, { sessionId: "full-linked-cwd" });
  const fullSession = {
    ...summarySession,
    initialCwd: linked,
    workingDirectories: [linked],
  };
  const bundle = evidence(fullSession, [firstLine, secondLine]);
  const source = new FakeAgentHistorySource(summarySession, bundle);
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.repositoryMatch, "linked-worktree");
  assert.equal(
    report.correlation?.selected?.signals.some((signal) => signal.kind === "structured-patch-overlap"),
    true,
  );
});

test("full evidence cwd missing or unresolvable retains unknown conservative behavior", async (t) => {
  const f = await fixture(t);
  const firstLine = "const missingEvidenceFirst = \"alpha\";";
  const secondLine = "const missingEvidenceSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const missingCwd = path.join(f.directory, "missing-evidence-cwd");

  const ref = reference(f, "missing-full-cwd");
  const session = summary(ref, f.directory, commit, { sessionId: "missing-full-cwd" });
  const bundle = evidence(session, [firstLine, secondLine]);
  const source = new FakeAgentHistorySource(session, {
    ...bundle,
    session: {
      ...session,
      workingDirectories: [f.directory, missingCwd],
    },
    evidence: [{
      ...bundle.evidence[0]!,
      cwd: missingCwd,
    }],
  });
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(report.correlation?.coverage.status, "limited");
});

test("unknown historical cwd with a resolved session-head projects only an exact target patch path", async (t) => {
  const f = await fixture(t);
  const firstLine = "const anchoredHistoricalFirst = \"alpha\";";
  const secondLine = "const anchoredHistoricalSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const missingCwd = path.join(f.directory, "arbitrary-unregistered-cwd");

  const ref = reference(f, "anchored-historical-cwd");
  const session = summary(ref, missingCwd, commit, { sessionId: "anchored-historical-cwd" });
  const source = new FakeAgentHistorySource(
    session,
    evidence(session, [firstLine, secondLine], "src-target.ts"),
  );
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.repositoryMatch, "unknown");
  assert.equal(
    report.correlation?.selected?.signals.some((signal) => signal.kind === "structured-patch-overlap"),
    true,
  );
  assert.equal(report.correlation?.coverage.status, "complete");
  assert.equal(JSON.stringify(report.correlation).includes(missingCwd), false);

  const noAnchorRef = reference(f, "unanchored-historical-cwd");
  const noAnchorSession = summary(noAnchorRef, missingCwd, commit, {
    sessionId: "unanchored-historical-cwd",
    transcriptGit: undefined,
  });
  const noAnchorSource = new FakeAgentHistorySource(
    noAnchorSession,
    evidence(noAnchorSession, [firstLine, secondLine], "src-target.ts"),
  );
  const noAnchorReport = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: noAnchorSource,
    codexHome: path.join(f.directory, "synthetic-home-no-anchor"),
  });

  assert.equal(noAnchorReport.correlation?.status, "none");
  assert.equal(noAnchorSource.scanCalls, 1);
  assert.equal(noAnchorSource.extractionCalls, 0);
  assert.equal(
    noAnchorReport.correlation?.coverage.limitations.some((value) =>
      value.kind === "unresolved-repository-candidate" && value.material),
    true,
  );
});

test("historical anchor projection rejects a basename-only patch path", async (t) => {
  const f = await fixture(t);
  const firstLine = "const basenameOnlyFirst = \"alpha\";";
  const secondLine = "const basenameOnlySecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const missingCwd = path.join(f.directory, "another-unregistered-cwd");
  const ref = reference(f, "basename-only-historical-cwd");
  const session = summary(ref, missingCwd, commit, { sessionId: "basename-only-historical-cwd" });
  const source = new FakeAgentHistorySource(
    session,
    evidence(session, [firstLine, secondLine], "target.ts"),
  );

  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(
    (report.correlation?.alternatives ?? []).some((candidate) =>
      candidate.signals.some((signal) => signal.kind.startsWith("structured-patch"))),
    false,
  );
});

test("an incompatible nested-repository distinctive patch cannot make a candidate strong", async (t) => {
  const f = await fixture(t);
  const firstLine = "const incompatibleFirst = \"alpha\";";
  const secondLine = "const incompatibleSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const nestedRepository = path.join(f.directory, "nested-repository");
  await mkdir(nestedRepository, { recursive: true });
  await runGit(f, ["init", "--initial-branch=nested", nestedRepository]);

  const ref = reference(f, "nested-distinctive-patch");
  const summarySession = summary(ref, f.directory, commit, { sessionId: "nested-distinctive-patch" });
  const fullSession = {
    ...summarySession,
    initialCwd: nestedRepository,
    workingDirectories: [nestedRepository],
  };
  const bundle = evidence(fullSession, [firstLine, secondLine], path.join(f.directory, "src-target.ts"));
  const source = new FakeAgentHistorySource(summarySession, bundle);
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(source.scanCalls, 1);
  assert.equal(source.extractionCalls, 0);
  assert.equal(report.correlation?.alternatives.length, 0);
});

test("mixed valid and nested-repository evidence retains the valid same-repository contribution", async (t) => {
  const f = await fixture(t);
  const firstLine = "const mixedFirst = \"alpha\";";
  const secondLine = "const mixedSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const nestedRepository = path.join(f.directory, "nested-repository");
  await mkdir(nestedRepository, { recursive: true });
  await runGit(f, ["init", "--initial-branch=nested", nestedRepository]);

  const ref = reference(f, "mixed-repositories");
  const session = summary(ref, f.directory, commit, { sessionId: "mixed-repositories" });
  const validBundle = evidence(session, [firstLine, secondLine]);
  const nestedBundle = evidence(session, [firstLine, secondLine]);
  const validEvidence = validBundle.evidence[0]!;
  const nestedEvidence = nestedBundle.evidence[0]!;
  const source = new FakeAgentHistorySource(session, {
    ...validBundle,
    session: {
      ...session,
      workingDirectories: [f.directory, nestedRepository],
    },
    evidence: [
      { ...validEvidence, id: "valid-evidence", cwd: f.directory },
      { ...nestedEvidence, id: "nested-evidence", cwd: nestedRepository, sourceRecord: 20 },
    ],
  });
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "matched");
  const overlap = report.correlation?.selected?.signals.find((signal) => signal.kind === "structured-patch-overlap");
  assert.deepEqual(overlap?.evidenceIds, ["valid-evidence"]);
  assert.equal(JSON.stringify(report.correlation).includes("nested-evidence"), false);
});

test("cwd-less full patch evidence cannot inherit the initial target mapping after nested context", async (t) => {
  const f = await fixture(t);
  const firstLine = "const cwdlessNestedFirst = \"alpha\";";
  const secondLine = "const cwdlessNestedSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const nestedRepository = path.join(f.directory, "nested-repository");
  await mkdir(nestedRepository, { recursive: true });
  await runGit(f, ["init", "--initial-branch=nested", nestedRepository]);

  const ref = reference(f, "cwdless-nested-context");
  const session = summary(ref, f.directory, commit, { sessionId: "cwdless-nested-context" });
  const bundle = evidence(session, [firstLine, secondLine]);
  const source = new FakeAgentHistorySource(session, {
    ...evidenceWithoutCwd(bundle),
    session: {
      ...session,
      workingDirectories: [f.directory, nestedRepository],
    },
  });
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(report.correlation?.coverage.status, "limited");
  assert.equal(report.correlation?.coverage.limitations.some((value) => value.material), true);
  assert.equal(
    (report.correlation?.alternatives ?? []).some((candidate) =>
      candidate.signals.some((signal) => signal.kind.startsWith("structured-patch"))),
    false,
  );
});

test("cwd-less evidence inherits when all observed directories share the target common Git directory", async (t) => {
  const f = await fixture(t);
  const firstLine = "const cwdlessSameCommonFirst = \"alpha\";";
  const secondLine = "const cwdlessSameCommonSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const observedDirectory = path.join(f.directory, "observed");
  await mkdir(observedDirectory, { recursive: true });
  const commit = await commitTarget(f);

  const ref = reference(f, "cwdless-same-common");
  const summarySession = summary(ref, f.directory, commit, { sessionId: "cwdless-same-common" });
  const fullSession = {
    ...summarySession,
    workingDirectories: [f.directory, observedDirectory],
  };
  const bundle = evidence(fullSession, [firstLine, secondLine]);
  const source = new FakeAgentHistorySource(summarySession, evidenceWithoutCwd(bundle));
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.repositoryMatch, "current-worktree");
  assert.equal(
    report.correlation?.selected?.signals.some((signal) => signal.kind === "structured-patch-overlap"),
    true,
  );
});

test("ambiguous cwd-less evidence records material coverage when it could affect uniqueness", async (t) => {
  const f = await fixture(t);
  const firstLine = "const cwdlessUnknownFirst = \"alpha\";";
  const secondLine = "const cwdlessUnknownSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const missingDirectory = path.join(f.directory, "missing-context");

  const ref = reference(f, "cwdless-unknown-context");
  const session = summary(ref, f.directory, commit, { sessionId: "cwdless-unknown-context" });
  const bundle = evidence(session, [firstLine, secondLine]);
  const source = new FakeAgentHistorySource(session, {
    ...evidenceWithoutCwd(bundle),
    session: {
      ...session,
      workingDirectories: [f.directory, missingDirectory],
    },
  });
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(report.correlation?.coverage.status, "limited");
  assert.equal(report.correlation?.coverage.limitations.some((value) => value.material), true);
});

test("cwd-less evidence remains valid across linked worktrees sharing the common Git directory", async (t) => {
  const f = await fixture(t);
  const firstLine = "const cwdlessLinkedFirst = \"alpha\";";
  const secondLine = "const cwdlessLinkedSecond = \"beta\";";
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const commit = await commitTarget(f);
  const linkedParent = await mkdtemp(path.join(os.tmpdir(), "whyline-cwdless-linked-"));
  const linked = path.join(linkedParent, "linked");
  t.after(async () => rm(linkedParent, { recursive: true, force: true }));
  await runGit(f, ["worktree", "add", "--detach", linked, commit]);

  const ref = reference(f, "cwdless-linked-context");
  const summarySession = summary(ref, f.directory, commit, { sessionId: "cwdless-linked-context" });
  const fullSession = {
    ...summarySession,
    workingDirectories: [f.directory, linked],
  };
  const bundle = evidence(fullSession, [firstLine, secondLine]);
  const source = new FakeAgentHistorySource(summarySession, evidenceWithoutCwd(bundle));
  const report = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: source,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.repositoryMatch, "current-worktree");
  assert.equal(report.correlation?.coverage.status, "complete");
});

test("worktree projection requires exact current identity and maps nested cwd paths", async (t) => {
  const f = await fixture(t);
  const firstLine = "const worktreeProjectionAnchorAlpha = \"alpha-value\";";
  const secondLine = "const worktreeProjectionAnchorBeta = \"beta-value\";";
  await writeFile(path.join(f.directory, "src-target.ts"), "baseline\n", "utf8");
  const commit = await commitTarget(f);
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const nested = path.join(f.directory, "nested");
  await mkdir(nested, { recursive: true });
  const ref = reference(f, "worktree-exact");
  const sessionValue = summary(ref, nested, commit);
  const source = new FakeAgentHistorySource(
    sessionValue,
    evidence(sessionValue, [firstLine, secondLine], "../src-target.ts"),
    { sourceSignature: { device: 1, inode: 2, size: 3, mtimeNs: 4n } },
  );
  const repository = await discoverRepositoryContext(f.runner, f.directory);
  const prepared = await prepareCodexEvidence({ repository, git: f.runner, agentHistorySource: source });
  const result = await projectPreparedCodex(
    prepared,
    worktreeTarget(repository, [firstLine, secondLine]),
    {} as ResolvedCodeLocation,
  );
  assert.equal(result.status, "matched");
  assert.equal(result.selected?.band, "strong");
});

test("linked worktree identity is never a positive worktree candidate", async (t) => {
  const f = await fixture(t);
  const firstLine = "const linkedProjectionAnchorAlpha = \"alpha-value\";";
  const secondLine = "const linkedProjectionAnchorBeta = \"beta-value\";";
  await writeFile(path.join(f.directory, "src-target.ts"), "baseline\n", "utf8");
  const commit = await commitTarget(f);
  await writeFile(path.join(f.directory, "src-target.ts"), `${firstLine}\n${secondLine}\n`, "utf8");
  const linked = `${f.directory}-linked`;
  t.after(async () => rm(linked, { recursive: true, force: true }));
  await runGit(f, ["worktree", "add", "--detach", linked, commit]);
  const ref = reference(f, "worktree-linked");
  const sessionValue = summary(ref, linked, commit);
  const source = new FakeAgentHistorySource(
    sessionValue,
    evidence(sessionValue, [firstLine, secondLine]),
    { sourceSignature: { device: 1, inode: 2, size: 3, mtimeNs: 4n } },
  );
  const repository = await discoverRepositoryContext(f.runner, f.directory);
  const prepared = await prepareCodexEvidence({ repository, git: f.runner, agentHistorySource: source });
  const result = await projectPreparedCodex(
    prepared,
    worktreeTarget(repository, [firstLine, secondLine]),
    {} as ResolvedCodeLocation,
  );
  assert.equal(result.status, "none");
  assert.equal(result.selected, undefined);
  assert.equal(result.alternatives.length, 0);
});

test("correction matrix 13: proof and cap inputs count deduplicated logical operations conservatively", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "src-target.ts"), "const terminalTarget = true;\n", "utf8");
  const commit = await commitTarget(f);
  const ref = reference(f, "terminal-proof");
  const sessionValue = summary(ref, f.directory, commit, { sessionId: "terminal-proof" });
  const validBundle = evidence(sessionValue, [
    "const terminalProofFirst = true;",
    "const terminalProofSecond = false;",
  ]);
  const validEvidence = validBundle.evidence[0]!;
  const terminalEvidence: AgentEvidence = {
    ...validEvidence,
    patch: {
      ...validEvidence.patch!,
      evidenceOrigins: ["self-contained-durable-terminal"],
    },
  };
  const terminalProjection: AgentCorrelationEvidenceProjection = {
    evidence: [terminalEvidence],
    unknownRecordCount: 0,
  };
  const potentiallyStrong = classifyStrongPossibility({
    repositoryMatch: "current-worktree",
    correlationEvidence: terminalProjection,
    relevanceCoverage: { status: "complete", reasons: [] },
    targetAliases: new Set(["src-target.ts"]),
  });
  assert.equal(potentiallyStrong.state, "cannot-prove");
  assert.equal(terminalProjection.evidence.length, 1);
  assert.deepEqual(terminalEvidence.patch?.evidenceOrigins, ["self-contained-durable-terminal"]);

  const malformed = classifyStrongPossibility({
    repositoryMatch: "current-worktree",
    correlationEvidence: terminalProjection,
    relevanceCoverage: { status: "limited", reasons: ["invalid-durable-patch-terminal"] },
    targetAliases: new Set(["src-target.ts"]),
  });
  assert.equal(malformed.state, "cannot-prove");

  const unlinkedOnly = classifyStrongPossibility({
    repositoryMatch: "current-worktree",
    correlationEvidence: terminalProjection,
    relevanceCoverage: { status: "limited", reasons: ["unlinked-patch-result"] },
    targetAliases: new Set(["src-target.ts"]),
  });
  assert.equal(unlinkedOnly.state, "cannot-prove");

  const cappedSummaries = Array.from({ length: 33 }, (_, index) => {
    const cappedRef = reference(f, `terminal-cap-${index.toString().padStart(2, "0")}`);
    return summary(cappedRef, f.directory, commit, { sessionId: `terminal-cap-${index.toString().padStart(2, "0")}` });
  });
  const cappedBundles = cappedSummaries.map((cappedSession) => ({
    ...validBundle,
    session: cappedSession,
    evidence: [{ ...terminalEvidence, id: `${cappedSession.sessionId}-evidence` }],
  }));
  const cappedSource = new FakeAgentHistorySource(cappedSummaries, cappedBundles);
  const cappedReport = await analyzeLocation("src-target.ts:1", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: cappedSource,
    codexHome: path.join(f.directory, "synthetic-home"),
  });
  assert.equal(cappedReport.correlation?.coverage.omittedPotentiallyStrongRefs, 1);
  assert.equal(cappedReport.correlation?.coverage.limitations.some((value) => value.kind === "candidate-cap" && value.material), true);
});
