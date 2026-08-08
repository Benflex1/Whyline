import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentDiagnostic,
  AgentEvidenceBundle,
  AgentHistoryAvailability,
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

function emptyEvidenceBundle(session: AgentSessionSummary): AgentEvidenceBundle {
  return {
    session,
    evidence: [],
    unknownRecordCount: 0,
    diagnostics: [],
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

interface FakeAgentHistoryOptions {
  readonly availability?: AgentHistoryAvailability;
  readonly diagnostics?: readonly AgentDiagnostic[];
}

class FakeAgentHistorySource implements AgentHistorySource {
  public readonly id = "fake";
  public discoverCalls = 0;
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
  assert.equal(report.correlation?.selected?.repositoryMatch, "current-worktree");
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
  const serializedCorrelation = JSON.stringify(report.correlation);
  assert.equal(serializedCorrelation.includes(f.directory), false);
  assert.equal(serializedCorrelation.includes("synthetic-home"), false);
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

  assert.equal(source.extractionCalls, 0);
  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.coverage.summaryEligibleRefs, 0);
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
    : emptyEvidenceBundle(value));
  const cappedSource = new FakeAgentHistorySource(summaries, bundles);
  const cappedReport = await analyzeLocation("src-target.ts:2", {
    currentDirectory: f.directory,
    git: f.runner,
    agentHistorySource: cappedSource,
    codexHome: path.join(f.directory, "synthetic-home"),
  });

  assert.equal(cappedSource.extractionCalls, 32);
  assert.equal(cappedReport.correlation?.status, "none");
  assert.equal(cappedReport.correlation?.coverage.omittedEligibleRefs, 1);
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

  assert.equal(unresolvedSource.extractionCalls, 1);
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
  assert.equal(report.correlation?.coverage.status, "complete");
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
  assert.equal(source.extractionCalls, 1);
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
