import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentDiagnostic,
  AgentEvidence,
  AgentEvidenceBundle,
  AgentEvidenceTarget,
  AgentHistoryAvailability,
  AgentHistoryDiscoveryContext,
  AgentHistoryDiscoveryResult,
  AgentHistorySource,
  AgentPatchChange,
  AgentSessionRef,
  AgentSessionSummary,
} from "../src/agents/agent-history-source.js";
import { CodexHistorySource } from "../src/agents/codex/index.js";
import { GitProcess, type GitRunner } from "../src/git/git-process.js";
import { analyzeLocation } from "../src/provenance/explain-location.js";
import { renderText } from "../src/cli/render-text.js";
import type { WhylineReport } from "../src/provenance/model.js";

const TARGET_PATH = "src/target.ts";
const TARGET_FIRST = "const lunaAnchorFirst = \"safe-alpha\";";
const TARGET_SECOND = "const lunaAnchorSecond = \"safe-beta\";";
const FIXED_START = "2026-08-08T01:00:00.000Z";
const FIXED_THROUGH = "2026-08-08T01:20:00.000Z";
const FIXED_PATCH_TIME = "2026-08-08T01:10:00.000Z";

function digestLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

interface GitFixture {
  readonly directory: string;
  readonly codexHome: string;
  readonly runner: GitProcess;
  readonly strictRunner: StrictReadOnlyGitRunner;
}

async function git(
  fixture: Pick<GitFixture, "directory" | "runner">,
  args: readonly string[],
): Promise<Buffer> {
  const result = await fixture.runner.run(args, { cwd: fixture.directory });
  if (result.exitCode !== 0) {
    throw new Error(`fixture Git command failed: ${args.join(" ")}`);
  }
  return result.stdout;
}

async function makeGitFixture(t: test.TestContext): Promise<GitFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-e2e-git-"));
  const globalConfig = path.join(directory, "empty-gitconfig");
  const codexHome = path.join(directory, "synthetic-codex-home");
  await writeFile(globalConfig, "", "utf8");
  await mkdir(codexHome, { recursive: true });
  const runner = new GitProcess({
    environment: {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_DATE: "2026-08-08T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-08T00:00:00Z",
      LC_ALL: "C",
      LANG: "C",
      CODEX_HOME: codexHome,
    },
  });
  const initial = await runner.run(["init", "--initial-branch=main"], { cwd: directory });
  assert.equal(initial.exitCode, 0, initial.stderr.toString("utf8"));
  await git({ directory, runner }, ["config", "user.name", "Whyline Synthetic"]);
  await git({ directory, runner }, ["config", "user.email", "synthetic@example.test"]);
  await git({ directory, runner }, ["config", "commit.gpgSign", "false"]);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, codexHome, runner, strictRunner: new StrictReadOnlyGitRunner(runner) };
}

async function writeFixtureFile(
  directory: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(directory, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function commitFile(
  fixture: GitFixture,
  relativePath: string,
  message: string,
): Promise<string> {
  await git(fixture, ["add", "--", relativePath]);
  await git(fixture, ["commit", "--no-verify", "-m", message]);
  return (await git(fixture, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

async function targetFixture(t: test.TestContext): Promise<GitFixture & { readonly commit: string }> {
  const fixture = await makeGitFixture(t);
  await writeFixtureFile(fixture.directory, TARGET_PATH, `${TARGET_FIRST}\n${TARGET_SECOND}\n`);
  const commit = await commitFile(fixture, TARGET_PATH, "synthetic target commit");
  return { ...fixture, commit };
}

function refFor(fixture: Pick<GitFixture, "codexHome">, sessionId: string): AgentSessionRef {
  return {
    adapterId: "synthetic",
    sourcePath: path.join(fixture.codexHome, `${sessionId}.jsonl`),
    sourceKind: "active",
  };
}

function session(
  ref: AgentSessionRef,
  cwd: string | undefined,
  commitHash: string | undefined,
  overrides: Partial<AgentSessionSummary> = {},
): AgentSessionSummary {
  return {
    ref,
    sessionId: path.basename(ref.sourcePath, ".jsonl"),
    startedAt: FIXED_START,
    observedThroughAt: FIXED_THROUGH,
    initialCwd: cwd,
    workingDirectories: cwd === undefined ? [] : [cwd],
    transcriptGit: commitHash === undefined
      ? undefined
      : { commitHash, referenceKind: "session-head" },
    isPartial: false,
    diagnostics: [],
    ...overrides,
  };
}

interface PatchSpec {
  readonly id: string;
  readonly path?: string;
  readonly changeType?: AgentPatchChange["changeType"];
  readonly payloadKind?: AgentPatchChange["payloadKind"];
  readonly matchSide?: AgentPatchChange["matchSide"];
  readonly lines: readonly string[];
  readonly sourceRecord?: number;
  readonly hunkRanges?: AgentPatchChange["hunkRanges"];
  readonly payloadTruncated?: boolean;
  readonly payloadRecovered?: boolean;
  readonly cwd?: string;
  readonly reportedSuccess?: boolean;
}

function patchChange(spec: PatchSpec): AgentPatchChange {
  const changeType = spec.changeType ?? "update";
  const payloadKind = spec.payloadKind
    ?? (changeType === "update" ? "unified-diff" : "content");
  const matchSide = spec.matchSide
    ?? (changeType === "delete" ? "deleted" : changeType === "update" ? "added" : "content");
  const fingerprints = spec.lines.map(digestLine);
  return {
    path: spec.path ?? TARGET_PATH,
    changeType,
    payloadKind,
    payloadRecovered: spec.payloadRecovered ?? true,
    payloadFingerprint: digestLine(spec.lines.join("\n")),
    payloadTruncated: spec.payloadTruncated ?? false,
    addedLineFingerprints: changeType === "delete" ? [] : fingerprints,
    matchLineFingerprints: fingerprints,
    distinctiveLineFingerprints: fingerprints,
    matchSide,
    hunkRanges: spec.hunkRanges
      ?? (matchSide === "added" ? [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }] : []),
    lineCount: spec.lines.length,
  };
}

function patchEvidence(
  sessionValue: AgentSessionSummary,
  spec: PatchSpec,
): AgentEvidence {
  const change = patchChange(spec);
  return {
    id: spec.id,
    kind: "patch-result",
    occurredAt: FIXED_PATCH_TIME,
    cwd: spec.cwd ?? sessionValue.initialCwd,
    paths: [change.path],
    operation: "patch",
    callId: spec.id,
    resultRecorded: true,
    reportedSuccess: spec.reportedSuccess ?? true,
    patch: {
      callId: spec.id,
      reportedSuccess: spec.reportedSuccess ?? true,
      changes: [change],
    },
    commitIds: [],
    extraction: "structured",
    sourceRecord: spec.sourceRecord ?? 10,
  };
}

function bundle(
  sessionValue: AgentSessionSummary,
  specs: readonly PatchSpec[],
  options: {
    readonly diagnostics?: readonly AgentDiagnostic[];
    readonly unknownRecordCount?: number;
    readonly includeCommandAttempt?: boolean;
  } = {},
): AgentEvidenceBundle {
  const evidence: AgentEvidence[] = specs.map((spec) => patchEvidence(sessionValue, spec));
  if (options.includeCommandAttempt === true) {
    evidence.push({
      id: "safe-command-attempt",
      kind: "command-attempt",
      cwd: sessionValue.initialCwd,
      paths: [],
      operation: "command",
      callId: "safe-command-call",
      resultRecorded: true,
      commitIds: [],
      extraction: "structured",
      sourceRecord: 4,
    });
  }
  return {
    session: sessionValue,
    evidence,
    unknownRecordCount: options.unknownRecordCount ?? 0,
    diagnostics: options.diagnostics ?? [],
  };
}

function emptyBundle(sessionValue: AgentSessionSummary): AgentEvidenceBundle {
  return {
    session: sessionValue,
    evidence: [],
    unknownRecordCount: 0,
    diagnostics: [],
  };
}

interface SyntheticSourceOptions {
  readonly availability?: AgentHistoryAvailability;
  readonly diagnostics?: readonly AgentDiagnostic[];
  readonly expectedHistoryRoot?: string;
  readonly throwOnSummary?: ReadonlySet<string>;
  readonly throwOnExtraction?: ReadonlySet<string>;
}

class SyntheticAgentHistorySource implements AgentHistorySource {
  public readonly id = "synthetic";
  public discoverCalls = 0;
  public legacyDiscoverCalls = 0;
  public scanCalls = 0;
  public readonly scannedRefPaths: string[] = [];
  public readonly scannedSessionIds: (string | null)[] = [];
  public readonly scanTargets: (AgentEvidenceTarget | undefined)[] = [];
  public summaryCalls = 0;
  public extractionCalls = 0;
  public readonly discoveryContexts: AgentHistoryDiscoveryContext[] = [];
  public readonly summarizedRefPaths: string[] = [];
  public readonly summarizedSessionIds: (string | null)[] = [];
  public readonly extractedRefPaths: string[] = [];
  public readonly extractedSessionIds: (string | null)[] = [];
  public readonly extractionTargets: (AgentEvidenceTarget | undefined)[] = [];
  private readonly summariesByPath: ReadonlyMap<string, AgentSessionSummary>;
  private readonly bundlesByPath: ReadonlyMap<string, AgentEvidenceBundle>;

  public constructor(
    summaries: readonly AgentSessionSummary[],
    bundles: readonly AgentEvidenceBundle[],
    private readonly options: SyntheticSourceOptions = {},
  ) {
    assert.equal(summaries.length, bundles.length);
    this.summariesByPath = new Map(summaries.map((value) => [value.ref.sourcePath, value]));
    this.bundlesByPath = new Map(bundles.map((value) => [value.session.ref.sourcePath, value]));
  }

  public async *discover(): AsyncIterable<AgentSessionRef> {
    this.legacyDiscoverCalls += 1;
    throw new Error("synthetic e2e source must use diagnostic discovery");
  }

  public async discoverWithDiagnostics(
    context?: AgentHistoryDiscoveryContext,
  ): Promise<AgentHistoryDiscoveryResult> {
    this.discoverCalls += 1;
    this.discoveryContexts.push(context ?? {});
    if (this.options.expectedHistoryRoot !== undefined) {
      assert.equal(context?.historyRoot, this.options.expectedHistoryRoot);
    }
    return {
      availability: this.options.availability ?? "available",
      refs: [...this.summariesByPath.values()].map((value) => value.ref),
      diagnostics: this.options.diagnostics ?? [],
    };
  }

  public async scanSummaryAndRelevance(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ) {
    this.scanCalls += 1;
    this.scannedRefPaths.push(ref.sourcePath);
    this.scanTargets.push(target);
    if (this.options.throwOnSummary?.has(ref.sourcePath)) {
      throw new Error("synthetic corrupt summary");
    }
    if (this.options.throwOnExtraction?.has(ref.sourcePath)) {
      throw new Error("synthetic corrupt transcript");
    }
    const summaryValue = this.summariesByPath.get(ref.sourcePath);
    assert.ok(summaryValue !== undefined);
    const bundle = this.bundlesByPath.get(ref.sourcePath);
    assert.ok(bundle !== undefined);
    this.scannedSessionIds.push(bundle.session.sessionId);
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
      sourceSignature: null,
    };
  }

  public async readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary> {
    this.summaryCalls += 1;
    this.summarizedRefPaths.push(ref.sourcePath);
    if (this.options.throwOnSummary?.has(ref.sourcePath)) {
      throw new Error("synthetic corrupt summary");
    }
    const value = this.summariesByPath.get(ref.sourcePath);
    assert.ok(value !== undefined);
    this.summarizedSessionIds.push(value.sessionId);
    return value;
  }

  public async extractEvidence(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ): Promise<AgentEvidenceBundle> {
    this.extractionCalls += 1;
    this.extractedRefPaths.push(ref.sourcePath);
    this.extractionTargets.push(target);
    if (this.options.throwOnExtraction?.has(ref.sourcePath)) {
      throw new Error("synthetic corrupt transcript");
    }
    const value = this.bundlesByPath.get(ref.sourcePath);
    assert.ok(value !== undefined);
    this.extractedSessionIds.push(value.session.sessionId);
    return value;
  }
}

const COMMIT_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%s", "%B"]
  .join("%x00") + "%x00";
const HEX_ID = /^[0-9a-fA-F]{7,128}$/;

function isHexCommit(value: string): boolean {
  return HEX_ID.test(value);
}

function isSafeRepositoryPath(value: string): boolean {
  return value.length > 0
    && !value.includes("\u0000")
    && !value.startsWith("-")
    && !value.includes("..")
    && !value.startsWith("/");
}

interface NormalizedGitArgs {
  readonly args: readonly string[];
  readonly configs: readonly string[];
}

function stripApprovedConfig(args: readonly string[]): NormalizedGitArgs | null {
  const result: string[] = [];
  const configs: string[] = [];
  let index = 0;
  while (index < args.length && args[index] === "-c") {
    const setting = args[index + 1];
    if (setting !== "core.quotePath=false" && setting !== "color.ui=false") {
      return null;
    }
    configs.push(setting);
    index += 2;
  }
  for (; index < args.length; index += 1) {
    const value = args[index];
    if (value === "-c") return null;
    result.push(value!);
  }
  return { args: result, configs };
}

function isAllowedReadOnlyGit(
  args: readonly string[],
  input: Uint8Array | undefined,
): boolean {
  const parsed = stripApprovedConfig(args);
  if (parsed === null || parsed.args.length === 0) return false;
  const normalized = parsed.args;
  const command = normalized[0];
  const expectedConfigs = command === "blame"
    ? ["core.quotePath=false", "color.ui=false"]
    : command === "diff" || command === "diff-tree"
      ? ["core.quotePath=false"]
      : [];
  const worktreeDiffWithoutConfig = command === "diff"
    && parsed.configs.length === 0
    && (normalized[1] === "--raw" || normalized[1] === "--patch");
  if (!worktreeDiffWithoutConfig
    && (parsed.configs.length !== expectedConfigs.length
      || parsed.configs.some((value, index) => value !== expectedConfigs[index]))) {
    return false;
  }
  const exact = (expected: readonly string[]): boolean =>
    normalized.length === expected.length && normalized.every((value, index) => value === expected[index]);

  if (command === "rev-parse") {
    if (exact(["rev-parse", "--is-bare-repository"])) return true;
    if (exact(["rev-parse", "--path-format=absolute", "--show-toplevel"])) return true;
    if (exact(["rev-parse", "--path-format=absolute", "--git-dir"])) return true;
    if (exact(["rev-parse", "--path-format=absolute", "--git-common-dir"])) return true;
    if (exact(["rev-parse", "--show-object-format"])) return true;
    if (exact(["rev-parse", "--is-shallow-repository"])) return true;
    if (exact(["rev-parse", "--verify", "HEAD"])) return true;
    return normalized.length === 4
      && normalized[1] === "--verify"
      && normalized[2] === "--quiet"
      && /^[0-9a-fA-F]{7,128}\^\{commit\}$/.test(normalized[3]!);
  }
  if (command === "symbolic-ref") return exact(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (command === "worktree") return exact(["worktree", "list", "--porcelain", "-z"]);
  if (command === "status") {
    return normalized.length === 6
      && normalized[1] === "--porcelain=v2"
      && normalized[2] === "-z"
      && normalized[3] === "--untracked-files=normal"
      && normalized[4] === "--"
      && isSafeRepositoryPath(normalized[5]!);
  }
  if (command === "ls-tree") {
    const historicalBlob = normalized.length === 6
      && normalized[1] === "-z"
      && normalized[2] === "--full-tree"
      && (isHexCommit(normalized[3]!) || normalized[3] === "HEAD")
      && normalized[4] === "--"
      && isSafeRepositoryPath(normalized[5]!);
    const headNames = normalized.length === 7
      && normalized[1] === "-r"
      && normalized[2] === "-z"
      && normalized[3] === "--name-only"
      && normalized[4] === "HEAD"
      && normalized[5] === "--"
      && isSafeRepositoryPath(normalized[6]!);
    return historicalBlob || headNames;
  }
  if (command === "ls-files") {
    const index = normalized.length === 5
      && normalized[1] === "--stage"
      && normalized[2] === "-z"
      && normalized[3] === "--"
      && isSafeRepositoryPath(normalized[4]!);
    const historical = normalized.length === 4
      && normalized[1] === "--error-unmatch"
      && normalized[2] === "--"
      && isSafeRepositoryPath(normalized[3]!);
    return index || historical;
  }
  if (command === "cat-file") {
    const commitExistence = normalized.length === 3
      && normalized[1] === "-e"
      && /^[0-9a-fA-F]{7,128}\^\{commit\}$/.test(normalized[2]!);
    const blobRead = normalized.length === 3
      && normalized[1] === "blob"
      && isHexCommit(normalized[2]!);
    const blobSize = normalized.length === 3
      && normalized[1] === "-s"
      && isHexCommit(normalized[2]!);
    return commitExistence || blobRead || blobSize;
  }
  if (command === "hash-object") {
    return exact(["hash-object", "-t", "tree", "--stdin"])
      && input !== undefined
      && input.byteLength === 0;
  }
  if (command === "show") {
    return normalized.length === 6
      && normalized[1] === "-s"
      && normalized[2] === "--no-color"
      && normalized[3] === "--no-show-signature"
      && normalized[4] === `--format=${COMMIT_FORMAT}`
      && isHexCommit(normalized[5]!);
  }
  if (command === "diff-tree") {
    const root = normalized.length === 8
      && normalized[1] === "--root"
      && normalized[2] === "-r"
      && normalized[3] === "-z"
      && normalized[4] === "--name-status"
      && normalized[5] === "-M"
      && normalized[6] === "--no-commit-id"
      && isHexCommit(normalized[7]!);
    const parent = normalized.length === 8
      && normalized[1] === "-r"
      && normalized[2] === "-z"
      && normalized[3] === "--name-status"
      && normalized[4] === "-M"
      && normalized[5] === "--no-commit-id"
      && isHexCommit(normalized[6]!)
      && isHexCommit(normalized[7]!);
    return root || parent;
  }
  if (command === "diff") {
    const committed = normalized.length >= 9
      && normalized[1] === "--no-ext-diff"
      && normalized[2] === "--no-color"
      && normalized[3] === "--find-renames"
      && normalized[4] === "--unified=3"
      && isHexCommit(normalized[5]!)
      && isHexCommit(normalized[6]!)
      && normalized[7] === "--"
      && normalized.slice(8).every(isSafeRepositoryPath);
    const rawWorktree = normalized.length === 10
      && normalized[1] === "--raw"
      && normalized[2] === "-z"
      && normalized[3] === "--no-abbrev"
      && normalized[4] === "--no-renames"
      && normalized[5] === "--no-ext-diff"
      && normalized[6] === "--no-textconv"
      && normalized[7] === "HEAD"
      && normalized[8] === "--"
      && isSafeRepositoryPath(normalized[9]!);
    const patchWorktree = normalized.length === 11
      && normalized[1] === "--patch"
      && normalized[2] === "--unified=0"
      && normalized[3] === "--no-indent-heuristic"
      && normalized[4] === "--no-renames"
      && normalized[5] === "--no-ext-diff"
      && normalized[6] === "--no-textconv"
      && normalized[7] === "--no-color"
      && normalized[8] === "HEAD"
      && normalized[9] === "--"
      && isSafeRepositoryPath(normalized[10]!);
    return committed || rawWorktree || patchWorktree;
  }
  if (command === "blame") {
    const baseline = normalized.length === 6
      && normalized[1] === "--line-porcelain"
      && normalized[2] === "-L"
      && /^\d+,\d+$/.test(normalized[3]!)
      && normalized[4] === "--"
      && isSafeRepositoryPath(normalized[5]!);
    const movement = normalized.length === 9
      && normalized[1] === "--line-porcelain"
      && normalized[2] === "-M"
      && normalized[3] === "-C"
      && normalized[4] === "-L"
      && /^\d+,\d+$/.test(normalized[5]!)
      && isHexCommit(normalized[6]!)
      && normalized[7] === "--"
      && isSafeRepositoryPath(normalized[8]!);
    return baseline || movement;
  }
  return false;
}

class StrictReadOnlyGitRunner implements GitRunner {
  public readonly calls: (readonly string[])[] = [];

  public constructor(private readonly delegate: GitRunner) {}

  public run(args: readonly string[], options: { readonly cwd: string; readonly input?: Uint8Array }) {
    this.calls.push([...args]);
    if (!isAllowedReadOnlyGit(args, options.input)) {
      throw new Error(`E2E strict Git allowlist rejected argv: ${args.join(" ")}`);
    }
    return this.delegate.run(args, options);
  }
}

async function analyzeWithSource(
  fixture: GitFixture,
  source: SyntheticAgentHistorySource,
  input = `${TARGET_PATH}:2`,
  codexHome = fixture.codexHome,
): Promise<WhylineReport> {
  return analyzeLocation(input, {
    currentDirectory: fixture.directory,
    git: fixture.strictRunner,
    agentHistorySource: source,
    codexHome,
  });
}

function assertNoTranscriptExecution(source: SyntheticAgentHistorySource): void {
  assert.equal(source.legacyDiscoverCalls, 0);
  assert.equal(source.discoverCalls, 2);
  assert.equal(source.scanCalls, 1);
  assert.equal(source.summaryCalls, 0);
  assert.equal(source.extractionCalls, 0);
}

test("synthetic end-to-end selection is conservative and renderer-safe", async (t) => {
  const matchingFixture = await targetFixture(t);
  const matchingRef = refFor(matchingFixture, "luna-match-01");
  const matchingSession = session(matchingRef, matchingFixture.directory, matchingFixture.commit);
  const matchingSource = new SyntheticAgentHistorySource(
    [matchingSession],
    [bundle(matchingSession, [{ id: "matching-patch", lines: [TARGET_FIRST, TARGET_SECOND] }])],
  );
  const matchingReport = await analyzeWithSource(matchingFixture, matchingSource);
  assert.equal(matchingReport.provenance.state, "committed");
  assert.equal(matchingReport.correlation?.status, "matched");
  assert.equal(matchingReport.correlation?.selected?.session.sessionId, "luna-match-01");
  assert.equal(matchingReport.correlation?.selected?.repositoryMatch, "current-worktree");
  assertNoTranscriptExecution(matchingSource);

  const unrelatedFixture = await targetFixture(t);
  const unrelatedRef = refFor(unrelatedFixture, "luna-unrelated-01");
  const unrelatedSession = session(unrelatedRef, unrelatedFixture.directory, unrelatedFixture.commit);
  const unrelatedSource = new SyntheticAgentHistorySource(
    [unrelatedSession],
    [emptyBundle(unrelatedSession)],
  );
  const unrelatedReport = await analyzeWithSource(unrelatedFixture, unrelatedSource);
  assert.equal(unrelatedReport.provenance.state, "committed");
  assert.equal(unrelatedReport.correlation?.status, "none");
  assert.equal(unrelatedReport.correlation?.alternatives.length, 0);

  const ambiguousFixture = await targetFixture(t);
  const ambiguousSessions = ["luna-ambiguous-01", "luna-ambiguous-02"].map((id) => {
    const ref = refFor(ambiguousFixture, id);
    return session(ref, ambiguousFixture.directory, ambiguousFixture.commit);
  });
  const ambiguousSource = new SyntheticAgentHistorySource(
    ambiguousSessions,
    ambiguousSessions.map((value, index) => bundle(value, [{
      id: `ambiguous-patch-${index + 1}`,
      lines: [TARGET_FIRST, TARGET_SECOND],
    }])),
  );
  const ambiguousReport = await analyzeWithSource(ambiguousFixture, ambiguousSource);
  assert.equal(ambiguousReport.correlation?.status, "ambiguous");
  assert.equal(ambiguousReport.correlation?.selected, undefined);
  assert.equal(ambiguousReport.correlation?.alternatives.length, 2);
  assert.equal(ambiguousReport.correlation?.alternatives.every((value) => value.band === "strong"), true);
  assert.equal(
    ambiguousReport.correlation?.alternatives.every((value) =>
      value.signals.some((signal) => signal.kind === "structured-patch-overlap")),
    true,
  );
  const ambiguousOutput = renderText(ambiguousReport);
  assert.match(ambiguousOutput, /Multiple strong candidates; no session selected/);
  assert.equal(ambiguousOutput.includes("Likely related Codex session"), false);

  const plausibleFixture = await targetFixture(t);
  const plausibleRef = refFor(plausibleFixture, "luna-plausible-01");
  const plausibleSession = session(plausibleRef, plausibleFixture.directory, plausibleFixture.commit);
  const plausibleSource = new SyntheticAgentHistorySource(
    [plausibleSession],
    [bundle(plausibleSession, [{ id: "plausible-patch", lines: [TARGET_FIRST] }])],
  );
  const plausibleReport = await analyzeWithSource(plausibleFixture, plausibleSource);
  assert.equal(plausibleReport.correlation?.status, "none");
  assert.equal(plausibleReport.correlation?.alternatives[0]?.band, "plausible");
  const plausibleOutput = renderText(plausibleReport);
  assert.match(plausibleOutput, /Possible related session: luna-plausible-01/);
  assert.match(plausibleOutput, /Evidence is insufficient to claim a match/);
});

test("empty and missing synthetic history preserve Git success, while uncommitted lines make zero discovery calls", async (t) => {
  const emptyFixture = await targetFixture(t);
  const emptySource = new SyntheticAgentHistorySource([], []);
  const emptyReport = await analyzeWithSource(emptyFixture, emptySource);
  assert.equal(emptyReport.provenance.state, "committed");
  assert.equal(emptyReport.correlation?.status, "none");
  assert.equal(emptyReport.correlation?.coverage.limitations.some((value) => value.kind === "empty-readable-store"), true);
  assert.match(renderText(emptyReport), /Textual attribution/);
  assert.doesNotMatch(renderText(emptyReport), /Likely related Codex session/);

  const missingFixture = await targetFixture(t);
  const missingHome = path.join(missingFixture.directory, "missing-synthetic-codex-home");
  const missingSource = new SyntheticAgentHistorySource([], [], {
    availability: "unavailable",
    expectedHistoryRoot: missingHome,
  });
  const missingReport = await analyzeWithSource(missingFixture, missingSource, `${TARGET_PATH}:2`, missingHome);
  assert.equal(missingReport.provenance.state, "committed");
  assert.equal(missingReport.correlation?.status, "unavailable");
  assert.equal(missingReport.correlation?.coverage.status, "unavailable");
  assert.match(renderText(missingReport), /Codex history unavailable/);
  assert.deepEqual(missingSource.discoveryContexts, [{ historyRoot: missingHome }]);

  const uncommittedFixture = await targetFixture(t);
  await writeFixtureFile(uncommittedFixture.directory, TARGET_PATH, `${TARGET_FIRST}\nconst locallyEdited = true;\n`);
  const uncommittedSource = new SyntheticAgentHistorySource([], []);
  const uncommittedReport = await analyzeWithSource(uncommittedFixture, uncommittedSource);
  assert.equal(uncommittedReport.provenance.state, "uncommitted");
  assert.equal(uncommittedReport.correlation, undefined);
  assert.equal(uncommittedSource.discoverCalls, 0);
  assert.equal(uncommittedSource.summaryCalls, 0);
  assert.equal(uncommittedSource.extractionCalls, 0);
});

test("stale session-head context does not defeat an equivalent current structured patch", async (t) => {
  const fixture = await targetFixture(t);
  const ref = refFor(fixture, "luna-stale-head-01");
  const staleSession = session(
    ref,
    fixture.directory,
    "1111111111111111111111111111111111111111",
  );
  const source = new SyntheticAgentHistorySource(
    [staleSession],
    [bundle(staleSession, [{ id: "current-equivalent-patch", lines: [TARGET_FIRST, TARGET_SECOND] }])],
  );
  const report = await analyzeWithSource(fixture, source);
  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.session.sessionId, "luna-stale-head-01");
  assert.equal(report.correlation?.selected?.signals.some((value) => value.kind === "structured-patch-overlap"), true);
  assert.equal(report.correlation?.selected?.signals.some((value) => value.kind === "session-head-target-reference"), false);
});

test("correction matrix 12: exact terminal-only P1 equivalent matches without exec provenance", async (t) => {
  const fixture = await targetFixture(t);
  const sessions = path.join(fixture.codexHome, "sessions", "2026", "08", "08");
  await mkdir(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, "orphaned-patch-result.jsonl");
  const patchPath = path.join(fixture.directory, TARGET_PATH);
  const records = [
    {
      timestamp: FIXED_START,
      type: "session_meta",
      payload: {
        session_id: "luna-orphaned-patch",
        timestamp: FIXED_START,
        cwd: fixture.directory,
        git: { commit_hash: fixture.commit },
      },
    },
    {
      timestamp: FIXED_PATCH_TIME,
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "call-non-patch",
        name: "exec",
        input: "opaque command text",
      },
    },
    {
      timestamp: "2026-08-08T01:10:01.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "call-non-patch",
        turn_id: "turn-terminal-only",
        status: "completed",
        success: true,
        changes: {
          [patchPath]: {
            type: "update",
            unified_diff: [
              "@@ -0,0 +1,2 @@",
              `+${TARGET_FIRST}`,
              `+${TARGET_SECOND}`,
            ].join("\n"),
          },
        },
      },
    },
  ];
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const report = await analyzeLocation(`${TARGET_PATH}:2`, {
    currentDirectory: fixture.directory,
    git: fixture.strictRunner,
    agentHistorySource: new CodexHistorySource(),
    codexHome: fixture.codexHome,
  });

  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.selected?.session.sessionId, "luna-orphaned-patch");
  assert.equal(report.correlation?.coverage.status, "complete");
  assert.equal(report.correlation?.coverage.omittedPotentiallyStrongRefs, 0);
  assert.doesNotMatch(renderText(report), /opaque command text/);
});

test("correction matrix 12: two independent terminal-only P2 equivalents are ambiguous", async (t) => {
  const fixture = await targetFixture(t);
  const sessions = path.join(fixture.codexHome, "sessions", "2026", "08", "08");
  await mkdir(sessions, { recursive: true });
  const patch = {
    [path.join(fixture.directory, TARGET_PATH)]: {
      type: "update",
      unified_diff: [
        "@@ -0,0 +1,2 @@",
        `+${TARGET_FIRST}`,
        `+${TARGET_SECOND}`,
      ].join("\n"),
    },
  };
  const records = (sessionId: string, callId: string, turnId: string) => [
    {
      timestamp: FIXED_START,
      type: "session_meta",
      payload: {
        session_id: sessionId,
        timestamp: FIXED_START,
        cwd: fixture.directory,
        git: { commit_hash: fixture.commit },
      },
    },
    {
      timestamp: FIXED_PATCH_TIME,
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: callId,
        turn_id: turnId,
        status: "completed",
        success: true,
        changes: patch,
      },
    },
  ];
  await writeFile(
    path.join(sessions, "terminal-a.jsonl"),
    `${records("terminal-a", "call-a", "turn-a").map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const isolated = await analyzeLocation(`${TARGET_PATH}:2`, {
    currentDirectory: fixture.directory,
    git: fixture.strictRunner,
    agentHistorySource: new CodexHistorySource(),
    codexHome: fixture.codexHome,
  });
  assert.equal(isolated.correlation?.status, "matched");

  await writeFile(
    path.join(sessions, "terminal-b.jsonl"),
    `${records("terminal-b", "call-b", "turn-b").map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const combined = await analyzeLocation(`${TARGET_PATH}:2`, {
    currentDirectory: fixture.directory,
    git: fixture.strictRunner,
    agentHistorySource: new CodexHistorySource(),
    codexHome: fixture.codexHome,
  });
  assert.equal(combined.correlation?.status, "ambiguous");
  assert.equal(combined.correlation?.alternatives.filter((candidate) => candidate.band === "strong").length, 2);
  assert.equal(combined.correlation?.coverage.omittedPotentiallyStrongRefs, 0);
  assert.equal(combined.correlation?.coverage.status, "complete");
});

test("privacy-sensitive synthetic transcript fields never reach terminal output or remote Git", async (t) => {
  const fixture = await targetFixture(t);
  const secret = "TRANSCRIPT_SECRET_COMMAND https://private.example.invalid /absolute/private/path";
  const ref = {
    ...refFor(fixture, "luna-private-01"),
    sourcePath: path.join(fixture.codexHome, "prompt-secret-transcript.jsonl"),
  };
  const privateSession = session(ref, fixture.directory, fixture.commit, {
    sessionId: "luna-private-01",
    source: secret,
    workingDirectories: [fixture.directory, secret],
  });
  const privateBundle = bundle(
    privateSession,
    [{ id: "private-patch", lines: [TARGET_FIRST, TARGET_SECOND] }],
    { includeCommandAttempt: true },
  );
  const source = new SyntheticAgentHistorySource([privateSession], [privateBundle]);
  const report = await analyzeWithSource(fixture, source);
  const output = renderText(report);
  assert.equal(report.correlation?.status, "matched");
  assert.equal(output.includes(secret), false);
  assert.equal(JSON.stringify(report.correlation).includes(secret), false);
  assert.equal(output.includes("prompt-secret-transcript"), false);
  assert.equal(output.includes("private.example.invalid"), false);
  assert.equal(output.includes("TRANSCRIPT_SECRET_COMMAND"), false);
  assert.equal(output.includes(fixture.codexHome), false);
  assert.equal(output.includes(fixture.directory), false);
});

test("bounded discovery reads every summary, extracts at most 32 candidates, and refuses uniqueness", async (t) => {
  const fixture = await targetFixture(t);
  const summaries = Array.from({ length: 40 }, (_, index) => {
    const id = `luna-cap-${index.toString().padStart(2, "0")}`;
    return session(refFor(fixture, id), fixture.directory, fixture.commit);
  });
  const bundles = summaries.map((value, index) => index === 0
    ? bundle(value, [{ id: "cap-matching-patch", lines: [TARGET_FIRST, TARGET_SECOND] }])
    : bundle(value, [{
      id: `cap-unrelated-patch-${index}`,
      lines: [TARGET_FIRST],
    }]));
  const source = new SyntheticAgentHistorySource(summaries, bundles);
  const report = await analyzeWithSource(fixture, source);
  const expectedSummaryRefPaths = summaries.map((value) => value.ref.sourcePath);
  const expectedSummarySessionIds = summaries.map((value) => value.sessionId);
  const scannedRefPaths = new Set(source.scannedRefPaths);
  const scannedSessionIds = new Set(source.scannedSessionIds);

  assert.equal(source.discoverCalls, 2);
  assert.equal(source.scanCalls, 40);
  assert.equal(source.summaryCalls, 0);
  assert.equal(source.extractionCalls, 0);
  assert.equal(source.scannedRefPaths.length, 40);
  assert.equal(scannedRefPaths.size, 40);
  assert.deepEqual(scannedRefPaths, new Set(expectedSummaryRefPaths));
  assert.equal(source.scannedSessionIds.length, 40);
  assert.equal(scannedSessionIds.size, 40);
  assert.deepEqual(scannedSessionIds, new Set(expectedSummarySessionIds));
  assert.equal(report.correlation?.coverage.discoveredRefs, 40);
  assert.equal(report.correlation?.coverage.usableSummaryRefs, 40);
  assert.equal(report.correlation?.coverage.fullyProjectedRefs, 32);
  assert.equal(report.correlation?.coverage.omittedPotentiallyStrongRefs, 8);
  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(report.correlation?.coverage.limitations.some((value) => value.kind === "candidate-cap" && value.material), true);
  const retainedObserved = report.correlation?.alternatives.find((value) => value.session.sessionId === "luna-cap-00");
  assert.ok(retainedObserved !== undefined);
  assert.equal(retainedObserved.band, "strong");
  assert.equal(retainedObserved.signals.some((value) => value.kind === "structured-patch-overlap"), true);
  assert.match(renderText(report), /No reliable Codex session match found/);
  assert.match(renderText(report), /Coverage: limited/);
});

test("current, linked, and deleted worktree sessions correlate without repository leakage", async (t) => {
  const currentFixture = await targetFixture(t);
  const currentSession = session(
    refFor(currentFixture, "luna-current-worktree"),
    currentFixture.directory,
    currentFixture.commit,
  );
  const currentSource = new SyntheticAgentHistorySource(
    [currentSession],
    [bundle(currentSession, [{ id: "current-worktree-patch", lines: [TARGET_FIRST, TARGET_SECOND] }])],
  );
  const currentReport = await analyzeWithSource(currentFixture, currentSource);
  assert.equal(currentReport.correlation?.status, "matched");
  assert.equal(currentReport.correlation?.selected?.repositoryMatch, "current-worktree");

  const linkedFixture = await targetFixture(t);
  const linkedParent = await mkdtemp(path.join(os.tmpdir(), "whyline-e2e-linked-"));
  const linked = path.join(linkedParent, "linked");
  t.after(async () => rm(linkedParent, { recursive: true, force: true }));
  await git(linkedFixture, ["worktree", "add", "--detach", linked, linkedFixture.commit]);
  const linkedSession = session(
    refFor(linkedFixture, "luna-linked-worktree"),
    linked,
    linkedFixture.commit,
  );
  const linkedSource = new SyntheticAgentHistorySource(
    [linkedSession],
    [bundle(linkedSession, [{ id: "linked-worktree-patch", lines: [TARGET_FIRST, TARGET_SECOND] }])],
  );
  const linkedReport = await analyzeWithSource(linkedFixture, linkedSource);
  assert.equal(linkedReport.correlation?.status, "matched");
  assert.equal(linkedReport.correlation?.selected?.repositoryMatch, "linked-worktree");

  const deletedFixture = await targetFixture(t);
  const deletedParent = await mkdtemp(path.join(os.tmpdir(), "whyline-e2e-deleted-linked-"));
  const deletedWorktree = path.join(deletedParent, "linked");
  const deletedCwd = path.join(deletedWorktree, "nested", "missing", "cwd");
  t.after(async () => rm(deletedParent, { recursive: true, force: true }));
  await git(deletedFixture, ["worktree", "add", "--detach", deletedWorktree, deletedFixture.commit]);
  const deletedPath = path.relative(deletedCwd, path.join(deletedWorktree, TARGET_PATH));
  await rm(deletedWorktree, { recursive: true, force: true });
  const deletedSession = session(
    refFor(deletedFixture, "luna-deleted-worktree"),
    deletedCwd,
    deletedFixture.commit,
  );
  const deletedSource = new SyntheticAgentHistorySource(
    [deletedSession],
    [bundle(deletedSession, [{
      id: "deleted-worktree-patch",
      path: deletedPath,
      lines: [TARGET_FIRST, TARGET_SECOND],
    }])],
  );
  const deletedReport = await analyzeWithSource(deletedFixture, deletedSource);
  assert.equal(deletedReport.correlation?.status, "matched");
  assert.equal(deletedReport.correlation?.selected?.repositoryMatch, "linked-worktree");
  assert.equal(JSON.stringify(deletedReport.correlation).includes(deletedWorktree), false);
});

test("a known unrelated repository is excluded before full evidence extraction", async (t) => {
  const fixture = await targetFixture(t);
  const unrelated = await makeGitFixture(t);
  await writeFixtureFile(unrelated.directory, "other.ts", "other repository\n");
  await commitFile(unrelated, "other.ts", "unrelated repository");
  const unrelatedSession = session(
    refFor(fixture, "luna-unrelated-repository"),
    unrelated.directory,
    fixture.commit,
  );
  const source = new SyntheticAgentHistorySource(
    [unrelatedSession],
    [bundle(unrelatedSession, [{ id: "should-not-extract", lines: [TARGET_FIRST, TARGET_SECOND] }])],
  );
  const report = await analyzeWithSource(fixture, source);
  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.coverage.usableSummaryRefs, 1);
  assert.equal(report.correlation?.coverage.incompatibleRefs, 1);
  assert.equal(source.scanCalls, 1);
  assert.equal(source.extractionCalls, 0);
  assert.equal(report.correlation?.alternatives.length, 0);
});

test("update, add, and delete structured patch sides all match their corresponding Git hunk", async (t) => {
  const updateFixture = await makeGitFixture(t);
  await writeFixtureFile(updateFixture.directory, TARGET_PATH, "const oldUpdateFirst = true;\nconst oldUpdateSecond = false;\n");
  await commitFile(updateFixture, TARGET_PATH, "update baseline");
  await writeFixtureFile(updateFixture.directory, TARGET_PATH, `${TARGET_FIRST}\n${TARGET_SECOND}\n`);
  const updateCommit = await commitFile(updateFixture, TARGET_PATH, "update target");
  const updateSession = session(refFor(updateFixture, "luna-update"), updateFixture.directory, updateCommit);
  const updateSource = new SyntheticAgentHistorySource(
    [updateSession],
    [bundle(updateSession, [{ id: "update-patch", lines: [TARGET_FIRST, TARGET_SECOND] }])],
  );
  const updateReport = await analyzeWithSource(updateFixture, updateSource);
  assert.equal(updateReport.correlation?.status, "matched");

  const addFixture = await makeGitFixture(t);
  await writeFixtureFile(addFixture.directory, TARGET_PATH, `${TARGET_FIRST}\n${TARGET_SECOND}\n`);
  const addCommit = await commitFile(addFixture, TARGET_PATH, "add target");
  const addSession = session(refFor(addFixture, "luna-add"), addFixture.directory, addCommit);
  const addSource = new SyntheticAgentHistorySource(
    [addSession],
    [bundle(addSession, [{
      id: "add-patch",
      changeType: "add",
      payloadKind: "content",
      matchSide: "content",
      lines: [TARGET_FIRST, TARGET_SECOND],
      hunkRanges: [],
    }])],
  );
  const addReport = await analyzeWithSource(addFixture, addSource);
  assert.equal(addReport.correlation?.status, "matched");

  const deleteFixture = await makeGitFixture(t);
  const deletedFirst = "const deletedAnchorFirst = true;";
  const deletedSecond = "const deletedAnchorSecond = false;";
  await writeFixtureFile(deleteFixture.directory, TARGET_PATH, `${deletedFirst}\n${deletedSecond}\nconst retainedAnchor = true;\n`);
  await commitFile(deleteFixture, TARGET_PATH, "delete baseline");
  await writeFixtureFile(deleteFixture.directory, TARGET_PATH, `${TARGET_FIRST}\n${TARGET_SECOND}\nconst retainedAnchor = true;\n`);
  const deleteCommit = await commitFile(deleteFixture, TARGET_PATH, "delete old anchors");
  const deleteSession = session(refFor(deleteFixture, "luna-delete"), deleteFixture.directory, deleteCommit);
  const deleteSource = new SyntheticAgentHistorySource(
    [deleteSession],
    [bundle(deleteSession, [{
      id: "delete-patch",
      changeType: "delete",
      payloadKind: "content",
      matchSide: "deleted",
      lines: [deletedFirst, deletedSecond],
      hunkRanges: [],
    }])],
  );
  const deleteReport = await analyzeWithSource(deleteFixture, deleteSource, `${TARGET_PATH}:1`);
  assert.equal(deleteReport.correlation?.status, "matched");
});

test("chronology suppresses an earlier competing patch but retains a later contradiction", async (t) => {
  const earlierFixture = await targetFixture(t);
  const earlierRef = refFor(earlierFixture, "luna-earlier-competition");
  const earlierSession = session(earlierRef, earlierFixture.directory, earlierFixture.commit);
  const divergentLines = ["const competingAnchorFirst = true;", "const competingAnchorSecond = false;"];
  const earlierSource = new SyntheticAgentHistorySource(
    [earlierSession],
    [bundle(earlierSession, [
      {
        id: "earlier-divergence",
        lines: divergentLines,
        sourceRecord: 10,
      },
      {
        id: "later-direct-match",
        lines: [TARGET_FIRST, TARGET_SECOND],
        sourceRecord: 20,
      },
    ])],
  );
  const earlierReport = await analyzeWithSource(earlierFixture, earlierSource);
  assert.equal(earlierReport.correlation?.status, "matched");

  const laterFixture = await targetFixture(t);
  const laterRef = refFor(laterFixture, "luna-later-competition");
  const laterSession = session(laterRef, laterFixture.directory, laterFixture.commit);
  const laterSource = new SyntheticAgentHistorySource(
    [laterSession],
    [bundle(laterSession, [
      {
        id: "earlier-direct-match",
        lines: [TARGET_FIRST, TARGET_SECOND],
        sourceRecord: 10,
      },
      {
        id: "later-divergence",
        lines: divergentLines,
        sourceRecord: 20,
      },
    ])],
  );
  const laterReport = await analyzeWithSource(laterFixture, laterSource);
  assert.equal(laterReport.correlation?.status, "none");
  assert.equal(laterReport.correlation?.alternatives[0]?.band, "plausible");
  assert.equal(laterReport.correlation?.alternatives[0]?.contradictions.some((value) => value.kind === "structured-content-divergence"), true);
  assert.match(renderText(laterReport), /Possible related session: luna-later-competition/);
});

test("benign unknown records do not block a complete direct match", async (t) => {
  const fixture = await targetFixture(t);
  const value = session(refFor(fixture, "luna-unknown-record"), fixture.directory, fixture.commit);
  const source = new SyntheticAgentHistorySource(
    [value],
    [bundle(value, [{ id: "unknown-record-match", lines: [TARGET_FIRST, TARGET_SECOND] }], {
      unknownRecordCount: 1,
      diagnostics: [{ kind: "unknown-record", record: 7 }],
    })],
  );
  const report = await analyzeWithSource(fixture, source);
  assert.equal(report.correlation?.status, "matched");
  assert.equal(report.correlation?.coverage.status, "complete");
  assert.equal(report.correlation?.coverage.limitations.some((value) => value.material), false);
});

test("partial, corrupt, changed-during-read, and materially compacted evidence cannot claim uniqueness", async (t) => {
  const cases: readonly {
    readonly id: string;
    readonly sessionOverrides?: Partial<AgentSessionSummary>;
    readonly diagnostics?: readonly AgentDiagnostic[];
    readonly limitation: string;
  }[] = [
    {
      id: "luna-partial",
      sessionOverrides: { isPartial: true },
      limitation: "partial-transcript",
    },
    {
      id: "luna-corrupt",
      diagnostics: [{ kind: "corrupt-non-final-record", record: 6 }],
      limitation: "corrupt-transcript",
    },
    {
      id: "luna-changed-during-read",
      diagnostics: [{ kind: "changed-during-read", record: 12 }],
      limitation: "changed-during-read",
    },
    {
      id: "luna-compacted",
      diagnostics: [{ kind: "compacted-history", record: 20 }],
      limitation: "material-compaction",
    },
  ];

  for (const row of cases) {
    const fixture = await targetFixture(t);
    const value = session(
      refFor(fixture, row.id),
      fixture.directory,
      fixture.commit,
      row.sessionOverrides,
    );
    const source = new SyntheticAgentHistorySource(
      [value],
      [bundle(value, [{ id: `${row.id}-patch`, lines: [TARGET_FIRST, TARGET_SECOND] }], {
        ...(row.diagnostics === undefined ? {} : { diagnostics: row.diagnostics }),
      })],
    );
    const report = await analyzeWithSource(fixture, source);
    assert.equal(report.correlation?.status, "none", row.id);
    assert.equal(report.correlation?.coverage.status, "limited", row.id);
    assert.equal(
      report.correlation?.coverage.limitations.some((value) => value.kind === row.limitation && value.material),
      true,
      row.id,
    );
    assert.match(renderText(report), /Possible related session/);
  }
});

test("a truncated Git hunk blocks matched status without inventing divergence", async (t) => {
  const fixture = await makeGitFixture(t);
  const longLine = `const truncationAnchor = "${"safe".repeat(10000)}";`;
  const secondLine = "const truncationSecondAnchor = true;";
  await writeFixtureFile(fixture.directory, TARGET_PATH, `${longLine}\n${secondLine}\n`);
  const commit = await commitFile(fixture, TARGET_PATH, "truncated Git hunk");
  const value = session(refFor(fixture, "luna-truncated-git-hunk"), fixture.directory, commit);
  const source = new SyntheticAgentHistorySource(
    [value],
    [bundle(value, [{
      id: "truncated-git-patch",
      lines: [longLine, secondLine],
    }])],
  );
  const report = await analyzeWithSource(fixture, source, `${TARGET_PATH}:2`);
  assert.equal(report.provenance.relevantHunks.some((value) => value.truncated), true);
  assert.equal(report.correlation?.status, "none");
  assert.equal(report.correlation?.selected, undefined);
  assert.equal(report.correlation?.coverage.limitations.some((value) => value.kind === "truncated-git-hunk" && value.material), true);
  assert.equal(report.correlation?.alternatives[0]?.contradictions.some((value) => value.kind === "structured-content-divergence"), false);
});
