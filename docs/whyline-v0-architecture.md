# Whyline v0: Architecture and Milestone Plan

**Status:** implemented baseline plus range-aware provenance milestone
**Date:** 2026-08-08

## Executive decision

Whyline v0 answers one question for one current worktree line and now also supports a bounded inclusive range:

```text
whyline <file>:<line>
whyline <file>:<start>-<end>
```

It resolves current Git attribution for each queried line, compresses only equivalent evidence into textual groups, inspects exact Git-visible ancestry for covered lines, searches local Codex history through a Codex-specific adapter, and renders a fact-first range report. A useful Git-only report is a successful result. A Codex session is shown as the likely source only when the evidence is strong and unambiguous; otherwise Whyline shows plausible candidates or says that no reliable session match was found.

The v0 pipeline should run on demand and keep no persistent index. The most important work before implementation is a focused, read-only Codex transcript preflight. OpenAI's current documentation names `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, but explicitly says the transcript format is not a stable interface. Designing a parser from assumed JSONL records would therefore be premature.

## Product boundary

### What v0 does

- Accepts exactly one positive, one-based line location in the form `<file>:<line>`.
- Accepts inclusive positive ranges in the form `<file>:<start>-<end>`, with ordered endpoints, both endpoints in the current UTF-8 text file, and a maximum of 200 lines.
- Accepts repository-relative and absolute paths; resolves them against the current process directory and rejects paths outside the discovered worktree.
- Operates on the current local worktree and `HEAD`, without fetching or contacting a remote.
- Supports ordinary non-bare Git repositories and linked worktrees.
- Detects whether the target line is committed, locally modified, untracked, missing, or outside a text file.
- For a committed line, reports the full blamed commit ID, original path and line where available, author/committer metadata, parents, subject, relevant changed paths, and the commit hunk associated with the target.
- Handles renames represented by Git's blame and diff machinery.
- Searches active and archived local Codex session stores, if enabled and readable.
- Extracts a small set of empirically supported Codex evidence: session identity and times, working directories, recorded command attempts, streamed terminal input, patch attempts and variant-specific patch results/change payloads, optional transcript Git revision metadata, tool-result linkage, and truncation/compaction warnings. It does not claim generic structured file reads or file writes.
- Correlates sessions without requiring that the session itself created a commit. This covers the common workflow where an agent edits and a human commits later.
- Renders a concise text report whose sections distinguish observed facts, deterministic derivations, and inferred correlation.
- Exits successfully when Git provenance is available but no Codex history or reliable match exists.
- Reads repository and Codex data only. It executes only read-only Git commands and never executes commands found in a transcript.

### What v0 does not do

- No symbols, commit queries, diff-hunk queries, or revision-qualified locations.
- No web UI, IDE integration, daemon, server, account, telemetry, or external upload.
- No GitHub, PR, issue, or remote-repository lookup.
- No additional agent adapters beyond Codex.
- No LLM, embeddings, vector database, generated narrative, or semantic search.
- No generic session browser or full prompt/transcript dump.
- No persistent index or SQLite database.
- No semantic ancestry claim. v0 reports **last textual attribution**, even if that attribution is a refactor.
- No attempt to attribute an uncommitted target line to an agent. It reports the dirty state and stops correlation because there is no responsible commit yet.
- No promise to recover sessions whose history is disabled, deleted, rotated, truncated, inaccessible, or in an unsupported transcript version.
- No automatic claim that the nearest session in time caused a change.
- No supported Windows release in the first milestone. Keep path parsing portable, but ship v0 for Linux and macOS; Windows requires separate drive, UNC, junction, and Git path-encoding fixtures.

### Explicit v0 behavior for awkward inputs

- **Dirty file, unchanged queried line:** use worktree-aware blame; if Git still attributes the line to a commit, report that attribution and prominently report the dirty file state.
- **Dirty or untracked queried line:** report `Uncommitted`; do not invent a commit or session correlation.
- **Deleted path:** reject it in v0 because the command addresses the current worktree.
- **Binary file or line beyond EOF:** return a location error.
- **No matching Codex session:** return the complete Git report and `Codex evidence: no reliable match found`.
- **Several strong candidates:** show an ambiguous result and the differentiating evidence; never select one merely because it is closest in time.

Use exit code `0` for every successfully analyzed location, including Git-only, ambiguous, and uncommitted reports; `2` for invalid input or an unsupported target; and `3` for an operational failure such as Git disappearing or the repository changing during analysis.

## Architecture choices considered

### Recommended: on-demand, staged analysis

Resolve one location, inspect one commit, scan cheap session metadata, then parse evidence only for eligible candidates. This is the smallest design, leaves no stale local state, and makes every result reproducible from current Git and transcript data.

### Deferred: transient metadata cache

A process-local cache could avoid reopening the same transcript during one invocation, but a disk cache has invalidation and privacy costs. An in-memory map is an implementation detail, not an architectural subsystem.

### Rejected for v0: SQLite index

An index improves repeated queries over very large histories, but v0 does not yet know transcript volume, record stability, or the fields worth indexing. It would introduce schema migration, invalidation, path-relocation, and deletion semantics before measurements justify them. Add persistence only after benchmarks show that header discovery exceeds an agreed latency budget on representative histories.

## Proposed architecture

Use strict TypeScript on Node.js 24 LTS, with ESM, npm, `tsc`, and the built-in `node:test` runner. The only required development packages should initially be `typescript` and `@types/node`; v0 needs no runtime dependency. Node's standard library covers subprocesses, paths, streaming JSONL, hashing, and filesystem access. Use a tiny hand-written parser for the single v0 command. Do not use a Git library: invoke the installed `git` executable with argument arrays and machine-readable formats, never through a shell. Require Git 2.31 or newer, then verify every selected option against that floor in CI.

Suggested source structure:

```text
src/
  cli/
    main.ts                 parse input, map errors to exit codes
    render-text.ts          terminal report only
    render-range-summary.ts bounded range summary
    render-range-details.ts bounded range forensic report
  location/
    parse-location.ts       <file>:<line>, including Windows-drive-safe parsing
    resolve-location.ts     canonical worktree-relative location and line state
  git/
    git-process.ts          typed, read-only subprocess boundary
    repository-context.ts   root/common-dir/worktree/HEAD/dirty identity
    blame-line.ts           one-line porcelain parser
    blame-range.ts          one-command range porcelain parser
    inspect-commit.ts       metadata, selected parent, paths, relevant hunks
    inspect-range.ts        deduplicated commit/parent inspection
    trace-range-ancestry.ts exact proof coverage for queried spans
  agents/
    agent-history-source.ts adapter contract and normalized types
    codex/
      discover.ts           active/archived store discovery
      parse-transcript.ts   version-tolerant streaming parser
      extract-evidence.ts   Codex records to normalized evidence
  correlation/
    model.ts                Git target, signal, candidate, and coverage types
    build-candidates.ts     eligibility and cheap filtering
    score-candidate.ts      signal calculation and confidence gates
    correlate.ts            selection versus ambiguity
  provenance/
    explain-location.ts     orchestration and fact/derivation/inference assembly
    explain-range.ts        range orchestration and stability gate
    range-model.ts          line facts, groups, coverage, and range report
    model.ts                shared domain types
test/
  fixtures/
    git/                    recipes or bundles for deterministic histories
    codex/                  synthetic, redacted transcript variants
```

Keep files focused, but do not create packages, dependency-injection machinery, a plugin registry, or a general provenance graph in v0.

### Core interfaces

The Git subprocess boundary should accept an explicit repository/worktree directory and an argument array, and return raw stdout bytes, stderr, and exit status. Parsers own decoding. This prevents locale, quoting, and shell-expansion bugs.

The agent extraction hint is deliberately separate from the rich correlation
target owned by `src/correlation/model.ts`:

```ts
interface AgentEvidenceTarget {
  repositoryPath?: string;
  line?: number;
  worktreeRoot?: string;
}

type AgentHistoryAvailability = "available" | "limited" | "unavailable";

interface AgentHistoryDiscoveryResult {
  availability: AgentHistoryAvailability;
  refs: AgentSessionRef[];
  diagnostics: AgentDiagnostic[];
}

interface AgentHistoryDiscoveryContext {
  historyRoot?: string;
}
```

The only agent abstraction needed now is:

```ts
interface AgentHistorySource {
  readonly id: "codex" | string;
  discover(context?: AgentHistoryDiscoveryContext): AsyncIterable<AgentSessionRef>;
  discoverWithDiagnostics?(context?: AgentHistoryDiscoveryContext): Promise<AgentHistoryDiscoveryResult>;
  readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary>;
  extractEvidence(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ): Promise<AgentEvidenceBundle>;
}
```

`discover` locates source records, `readSummary` extracts cheap candidate metadata, and `extractEvidence` performs the expensive stream pass. Correlation remains agent-neutral and consumes normalized evidence; Codex-specific event names and JSON shapes do not escape the adapter.

`CorrelationTarget` is the rich Git-derived value consumed by the pure
correlation layer. It is not the adapter extraction hint and is not passed as a
Codex parser structure.

The adapter must expose parser diagnostics and coverage gaps. Unknown records are skipped and counted, not treated as evidence and not fatal unless required session identity cannot be established.

Discovery must also distinguish a readable source with zero refs from a limited
or unavailable source. A readable Codex home with readable stores and no
transcripts is `available`; a readable home with partially unreadable stores is
`limited`; an unavailable or unreadable effective home is `unavailable`.

The integration exposes only narrow analysis-level seams for an injected
`AgentHistorySource` and an optional Codex history root used by tests and staged
callers. The normal CLI resolves `CODEX_HOME` or the process home's `.codex`;
there is no general configuration surface or persistent history state.

### Data flow

1. Parse `<file>:<line>` from the right so paths containing colons can be handled where possible.
2. Discover the containing worktree and build a repository identity.
3. Validate the current text line and inspect target-path dirty state.
4. Run one-line blame against the worktree. If the line is uncommitted, build a Git/working-tree-only result.
5. Load the blamed commit and choose the parent relevant to the blamed line; then compute changed paths and the relevant hunk against that parent.
6. Ask each configured `AgentHistorySource` (Codex only in v0) for summaries that may belong to this repository.
7. Exclude known repository mismatches. Rank summaries cheaply, then extract full evidence only for eligible candidates.
8. Calculate independent correlation signals and contradictions. Apply confidence gates and ambiguity rules.
9. Assemble a report model with explicit claim provenance and render it.

### Range data flow

Range analysis is a dedicated aggregation path:

1. Parse and resolve the range once, including one UTF-8 file snapshot.
2. Run one `git blame --line-porcelain -L START,END -- PATH` and retain one fact per queried line.
3. Load unique commit metadata once, select parents from each line's blame evidence, and inspect each reusable commit/parent/path group once.
4. Trace movement-aware ancestry at span granularity. Exact status is attached only to queried lines covered by independently valid exact proof blocks; uncovered lines remain separately typed.
5. Prepare Codex history once, then project the unchanged correlation semantics independently onto committed textual groups.
6. Deep-analyze only the first 24 committed textual groups in source order. Later groups are `unavailable / work-bound`; uncommitted groups receive no ancestry or Codex attribution.
7. Verify repository HEAD, branch, target snapshot, and dirty state before rendering the successful result.

Grouping is deterministic compression, never authority. Textual groups retain their separate source spans and split on committed/uncommitted state, commit, blamed path, or selected parent differences.

## Provenance model

Every user-visible claim has a `basis`:

| Basis | Meaning | Examples |
| --- | --- | --- |
| `fact` | Directly observed in Git, the filesystem, or a transcript record | commit ID, commit subject, session cwd, a recorded tool call, a tool-reported patch result |
| `derived` | Deterministic transformation of facts | canonical repository identity, selected commit hunk, changed-path overlap, normalized patch fingerprint |
| `inferred` | A causal or semantic conclusion supported by signals | a Codex session likely produced the commit |

Transcript evidence is a fact about the transcript, not automatically a fact about the final repository. For example, `apply_patch` invocation is evidence that Codex attempted a patch; a matching result is evidence the tool reported completion or failure; only current Git proves what the commit contains. The observed shell schemas do not provide a stable structured exit-status field, so command, test, build, and lint records are attempts only. A future schema with structured status may add a separate success fact.

### Data model

```ts
type ClaimBasis = "fact" | "derived" | "inferred";

interface RepositoryIdentity {
  worktreeRoot: string;       // canonical absolute path
  gitDir: string;             // worktree-specific Git directory
  commonGitDir: string;       // shared identity across linked worktrees
  objectFormat: "sha1" | "sha256" | string;
  headCommit: string | null;  // null for unborn HEAD
  branch: string | null;      // null when detached
}

interface CodeLocation {
  input: string;
  absolutePath: string;
  repositoryPath: string;     // slash-normalized Git path
  startLine: number;          // same as endLine in v0
  endLine: number;
  revision: "WORKTREE";
  lineDigest: string;         // ephemeral digest, never a persistent identity
}

type LocationQuery =
  | { kind: "line"; file: string; line: number }
  | { kind: "range"; file: string; startLine: number; endLine: number };

interface ResolvedRangeCodeLocation extends CodeLocation {
  startLine: number;
  endLine: number;
  lineContents: string[];
  lineDigests: string[];
  targetState: string;
  targetDirty: boolean;
}

interface GitProvenance {
  state: "committed" | "uncommitted";
  targetDirty: boolean;
  commit?: GitCommit;
  blamedPath?: string;
  blamedLine?: number;
  selectedParent?: string;
  blobId?: string;
  changedPaths: GitPathChange[];
  relevantHunks: GitHunk[];
  limitations: string[];
}

interface GitCommit {
  id: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  subject: string;
  body: string;
}

interface AgentSessionRef {
  adapterId: string;
  sourcePath: string;         // opaque read handle; filename is not identity
  sourceKind: "active" | "archived" | string;
}

interface AgentSessionSummary {
  ref: AgentSessionRef;
  sessionId: string | null;    // null means this source is unusable, never a guessed ID
  startedAt?: string;
  observedThroughAt?: string;  // last valid record timestamp, not session termination
  initialCwd?: string;
  workingDirectories: string[];
  adapterSchema?: string;
  surface?: string;
  originator?: string;
  source?: string;
  clientVersion?: string;
  model?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  transcriptGit?: {
    branch?: string;
    commitHash?: string;
    referenceKind?: "session-head" | "produced-commit" | "unknown";
  };
  isPartial: boolean;
  diagnostics: AgentDiagnostic[];
}

type EvidenceKind =
  | "command-attempt"
  | "stream-input"
  | "patch-attempt"
  | "patch-result"
  | "git-revision-reference"
  | "mcp-operation";

type AgentOperation =
  | "command"
  | "terminal-input"
  | "patch"
  | "mcp";

type AgentCommitReferenceKind = "session-head" | "produced-commit" | "unknown";

interface AgentPatchHunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

type AgentPatchMatchSide = "added" | "deleted" | "content";

interface AgentPatchChange {
  path: string;
  changeType: "update" | "add" | "delete" | "unknown";
  payloadKind: "unified-diff" | "content";
  payloadRecovered: boolean;
  payloadFingerprint: string;
  payloadTruncated: boolean;
  /** Compatibility field; correlation uses the explicit side fields below. */
  addedLineFingerprints: string[];
  matchLineFingerprints: string[];
  distinctiveLineFingerprints: string[];
  matchSide: AgentPatchMatchSide;
  hunkRanges: AgentPatchHunkRange[];
  lineCount: number;
  movedFrom?: string;
}

// `matchLineFingerprints` and `matchSide` are normalized together:
// update/unified-diff uses added lines, add/content uses post-image content, and
// delete/content uses deleted content. `distinctiveLineFingerprints` is the
// bounded subset that passes the non-boilerplate classification used to prove
// two-line overlap or content divergence. `hunkRanges` contains only numeric
// unified-diff coordinates; raw patch/source text is not retained.
// `addedLineFingerprints` remains a compatibility field and is not used to
// infer delete semantics.

interface AgentPatchEvidence {
  callId: string;
  reportedSuccess?: boolean;
  status?: string;
  changes: AgentPatchChange[];
}

interface AgentEvidence {
  id: string;
  kind: EvidenceKind;
  occurredAt?: string;
  cwd?: string;
  paths: string[];
  operation?: AgentOperation;
  callId?: string;
  resultRecorded?: boolean;
  terminalSessionId?: string;
  reportedSuccess?: boolean;
  status?: string;
  patch?: AgentPatchEvidence;
  commitReferenceKind?: AgentCommitReferenceKind;
  commitIds: string[];
  extraction: "structured";
  sourceRecord: number;
}

// The current adapter will mark `session_meta.payload.git.commit_hash` and its
// normalized `git-revision-reference` evidence as
// `commitReferenceKind: "session-head"`. This is repository/HEAD context, not a
// claim that the session produced the commit. `produced-commit` is reserved for
// a future empirically verified reference kind.

type AgentDiagnosticKind =
  | "unknown-record"
  | "compacted-history"
  | "context-compaction"
  | "thread-rollback"
  | "turn-aborted"
  | "partial-final-record"
  | "corrupt-non-final-record"
  | "unreadable-transcript"
  | "changed-during-read"
  | "missing-session-metadata"
  | "conflicting-session-metadata"
  | "unlinked-tool-result"
  | "invalid-timestamp"
  | "malformed-tool-arguments"
  | "retention-limit"
  | "unsupported-source";

interface AgentDiagnostic {
  kind: AgentDiagnosticKind;
  record?: number;
  detail?: string; // bounded and control-character-free; never raw transcript text
}

interface AgentEvidenceBundle {
  session: AgentSessionSummary;
  evidence: AgentEvidence[];
  unknownRecordCount: number;
  diagnostics: AgentDiagnostic[];
}

type CorrelationSignalKind =
  | "session-head-target-reference"
  | "produced-target-commit-reference"
  | "historical-commit-reference"
  | "structured-patch-overlap"
  | "exact-current-worktree"
  | "linked-worktree-common-directory"
  | "structured-patch-target-path"
  | "changed-path-overlap"
  | "structured-patch-attempt-target-path"
  | "temporal-proximity"
  | "structured-content-divergence";

interface CorrelationSignal {
  kind: CorrelationSignalKind;
  weight: number;
  basis: ClaimBasis;
  evidenceIds: string[];
}

interface CorrelationCandidate {
  session: AgentSessionSummary;
  eligible: boolean;
  repositoryMatch: "current-worktree" | "linked-worktree" | "same-common-directory" | "historical-commit-anchored" | "unknown" | "incompatible";
  score: number;              // internal ordering only
  signals: CorrelationSignal[];
  contradictions: CorrelationSignal[];
  band: "strong" | "plausible" | "weak";
  coverage: "complete" | "limited";
  coverageLimitations: CorrelationLimitation[];
}

type CorrelationLimitationKind =
  | "empty-readable-store"
  | "discovery-unavailable"
  | "discovery-limited"
  | "unsupported-summary"
  | "unresolved-repository-candidate"
  | "candidate-cap"
  | "summary-coverage"
  | "partial-transcript"
  | "corrupt-transcript"
  | "changed-during-read"
  | "truncated-git-hunk"
  | "truncated-patch-payload"
  | "material-compaction"
  | "material-rollback-or-abort";

interface CorrelationLimitation {
  kind: CorrelationLimitationKind;
  material: boolean;
  count?: number;
}

interface CorrelationCoverage {
  status: "complete" | "limited" | "unavailable";
  discoveredRefs: number;
  summaryEligibleRefs: number;
  fullyExtractedRefs: number;
  omittedEligibleRefs: number;
  limitations: CorrelationLimitation[];
}

interface CorrelationResult {
  status: "matched" | "ambiguous" | "none" | "unavailable";
  selected?: CorrelationCandidate;
  alternatives: CorrelationCandidate[];
  coverage: CorrelationCoverage;
}
```

`sessionId` is populated only from the transcript's structured session metadata;
a source without it is an unsupported/diagnostic result, never a filename-based
session. A subagent transcript is a separate `AgentSessionSummary` and retains
its observed parent/fork IDs rather than being flattened into the root session.

Correlation signals expose closed kinds and evidence identifiers rather than
free-form renderer messages. The terminal renderer maps signal, limitation, and
result-status kinds to fixed bounded explanations and never renders arbitrary
domain keys or transcript-derived prose.

Do not persist `lineDigest` as the identity of a line. Lines are not durable entities across edits. It is only useful during one analysis for exact comparisons.

## Correlation model

### Eligibility before scoring

Scoring cannot repair an identity mistake. Apply these gates first:

1. A session with a known, incompatible repository identity is excluded even if relative paths and timestamps match.
2. Prefer a canonical worktree match. Treat any cwd belonging to a worktree returned by `git worktree list --porcelain -z` as belonging to the same repository, while retaining which worktree produced the evidence.
3. If the recorded cwd no longer exists, a session-head commit reference or another future normalized repository/commit anchor may keep the candidate eligible for bounded evaluation, but transcript cwd/branch/session-head metadata never establishes durable repository identity or `commonGitDir`; path basename alone never establishes repository identity.
4. The observed `session_meta.payload.git.commit_hash` is session-head context, not evidence that the session produced the commit. With unknown repository context it can participate in a historical conjunction with distinctive structured patch overlap, but it cannot select a candidate by itself. A future empirically verified produced-commit reference may be a direct anchor.
5. Time is never an eligibility requirement. Rebases, squash merges, delayed commits, and amended commits make commit times unreliable causal boundaries.

Transcript repository URLs are never retained or rendered. Git-side repository
and worktree discovery remains authoritative for repository identity and
`commonGitDir`; transcript cwd, optional branch, and optional commit hash are
correlation evidence only.

The staged coordinator reclassifies the full evidence bundle before projecting
it into the pure domain. Evidence from a known incompatible repository is
discarded. If full-bundle working-directory context is incompatible or
unresolvable, cwd-less evidence is not inherited from the initial mapping;
relevant dropped records add a material coverage limitation. Explicit evidence
with a compatible cwd can still contribute, while missing or unresolvable paths
never establish repository identity.

The Codex extractor maintains the best-known structured effective cwd in
transcript order. It initializes and updates that state only from the supported
cwd-bearing `session_meta`, `turn_context`, and
`thread_settings_applied` records, then attaches the state to each emitted
`patch-result` when available. This preserves a deleted historical cwd for the
session-head plus structured-patch recovery conjunction, while ensuring a
later nested-repository cwd excludes subsequent patch evidence. If no
structured cwd is known, patch paths are quarantined rather than normalized
against `initialCwd` or treated as repository identity; material ambiguity is
reported in correlation coverage.

### Signals and initial weights

Use an explainable additive score only to order candidates within confidence gates. Initial weights should be fixture-calibrated, not presented to users as probabilities:

| Signal | Weight | Notes |
| --- | ---: | --- |
| Target session-head commit context resolves to the attributed commit | +2 | Cheap ranking/summary anchor only; not a current-v0 direct change anchor |
| Empirically verified produced-commit reference resolves to the attributed commit | +10 | Reserved for a future structured reference kind; abbreviated IDs must resolve uniquely in this repository |
| Agent patch/post-image overlaps the relevant commit hunk | +8 | Compare operation-appropriate normalized line fingerprints; require at least two distinctive lines |
| Exact target worktree identity | +5 | Use canonical path plus Git worktree mapping |
| Same common Git directory through another known worktree | +4 | Important for Codex-managed detached worktrees |
| Successful recovered structured patch affects the blamed path | +4 | Only supported patch variants supply structured change data; resolve paths relative to the session/event cwd |
| Meaningful overlap with the commit's changed-file set | +1 to +3 | Based on overlap size; filenames alone are not decisive |
| Temporal proximity | 0 to +2 | Bounded weak signal; use session interval versus author and committer times |
| Known incompatible repository identity | exclusion | Resolve before scoring; no additive score can repair the identity contradiction |
| `structured-content-divergence` | -5 | Only supported competing content that is operation-, hunk-, and chronology-aware; truncation suppresses this inference |

Patch fingerprints should normalize line endings and insignificant diff metadata, but should not normalize identifiers, literals, or broad whitespace so aggressively that unrelated edits collide. Require at least two distinctive matching lines from a supported successful structured patch. The current session-head reference is contextual and does not satisfy the direct-anchor requirement.

Content divergence is not inferred from a same-file path alone. A supported
successful change must contain two distinctive lines, target the relevant hunk,
and lack direct overlap; a later direct match supersedes an earlier divergence,
while a later competing change remains active. When a relevant Git hunk is
truncated, absence of overlap cannot establish divergence.

### Confidence bands and ambiguity

The report should never display `83% confidence`. The inputs are incomplete and correlated, so that number would imply calibration that does not exist.

- **Strong:** credible repository compatibility plus qualifying distinctive supported patch/post-image overlap. The current session-head commit reference is contextual only; a future produced-commit reference may become a direct anchor after empirical verification. No material contradiction.
- **Plausible:** exact repository identity plus at least two independent supporting signals, at least one involving a write or changed-set overlap. Time plus same filename is not enough.
- **Weak:** everything else that survives eligibility.

Select a session only when exactly one candidate is `strong`. If two candidates are strong, return `ambiguous` regardless of score. A lone plausible candidate may be displayed under `Possible Codex session`, never as the source. Weak candidates should normally be summarized as no reliable match.

Selection also requires complete candidate-set coverage. One strong candidate
with a material transcript, discovery, or relevant-Git-hunk limitation returns
`none` with possible evidence retained; it is not promoted to `matched`. An
empty readable Codex store returns `none`, while `unavailable` is reserved for
an unreadable or unavailable effective history source.

This rule deliberately sacrifices recall. A false causal story is worse than a Git-only answer.

### How the model survives history rewriting

- **Rebase/amend:** current commit IDs and committer timestamps may differ from the session. Worktree identity, changed paths, and hunk overlap remain useful; stale session-head SHA references are contextual evidence, not an automatic match.
- **Squash merge:** several sessions may overlap one final commit. The result remains ambiguous unless one has distinctive hunk overlap and the others do not. v0 does not divide a commit among sessions line by line beyond the queried hunk.
- **Human edits after agent work:** reduced or contradictory hunk overlap lowers confidence. Whyline can say the session is plausible evidence without claiming the final line is agent-authored.
- **Multiple sessions on the same code:** direct hunk overlap outranks session-head context and time. Multiple strong candidates remain visible as ambiguity.
- **Session without a commit:** it can still match through repository, supported patch evidence, and changed-set overlap.
- **Missing/truncated history:** report adapter coverage limitations; absence of evidence is not evidence of human authorship.

## Codex preflight questions

Before implementing the Codex adapter, inspect a small, consented, read-only sample of real local data from each Codex surface that is intended to count as supported. Produce redacted synthetic fixtures from the observations; do not check personal prompts, credentials, or raw transcripts into the repository.

The preflight must answer these exact questions:

1. What determines the effective `CODEX_HOME`, and do the CLI, IDE, desktop app, and `codex exec` use the same home in practice?
2. What is the directory and filename layout under `sessions` and `archived_sessions`? Are date partitions or filename timestamps contractual or incidental?
3. What is `history.jsonl` relative to per-session transcripts: prompt index, complete transcript, legacy store, or something else?
4. Which record establishes session/thread ID, creation time, cwd, origin surface, model, client/version, and parent/fork relationship?
5. Are timestamps monotonic, optional, duplicated, local-time, or UTC? Is there a reliable end time?
6. Can cwd change within a session or per tool call? How are linked and Codex-managed worktree paths represented?
7. What are the JSON envelopes and discriminators for user messages, assistant messages, tool calls, tool results, compaction summaries, and errors?
8. How are tool call and result records linked? Is exit status structured for shell commands?
9. How are `exec_command`, streamed `write_stdin`, shell aliases, `apply_patch`, direct file-edit tools, MCP filesystem tools, and subagent tool calls represented across current versions?
10. Are command arguments stored as an argv array, shell string, or both? Which fields can be trusted without shell parsing?
11. Does an apply-patch/edit event contain the full patch or only arguments? Can a successful write be distinguished from an attempted or partially applied write?
12. How are tool outputs truncated, spilled, compacted, or redacted, and is that state explicitly marked?
13. How are resumed, forked, compacted, archived, deleted, and multi-agent sessions represented? Do subagents have separate transcripts or share the root session ID?
14. Can files be concurrently appended while Whyline reads them? Are partial trailing JSONL records expected, and are files atomically rotated?
15. Which schema changes exist across at least the oldest locally retained version and the current version?
16. Can transcript records contain absolute repository paths, secrets, environment variables, or prompt contents that must never be echoed by default?
17. Can successful Git commands and their outputs establish a common Git directory or target commit, or is only cwd reliably available?
18. How many sessions and bytes exist in a realistic long-lived profile, and how long do header-only discovery and targeted full parsing take?
19. What happens when history persistence is `none` or `history.max_bytes` has compacted older data?
20. Is there any supported read API or stable exported schema that should be preferred over parsing transcripts? Current documentation says transcript format is not stable, so this must be rechecked against the installed Codex version.

The preflight deliverable should be a short format matrix, parser invariants, unsupported variants, redacted fixtures, and scan benchmarks. It should not build the production adapter.

## Git strategy

### Repository and worktree context

Run commands through the Git runner with `<resolved-directory>` as the subprocess working directory (equivalent to `git -C`) and a fixed environment that disables optional locks, color, pagers, and locale-dependent presentation where applicable.

- `git rev-parse --path-format=absolute --show-toplevel`
- `git rev-parse --path-format=absolute --git-dir`
- `git rev-parse --path-format=absolute --git-common-dir`
- `git rev-parse --show-object-format`
- `git rev-parse --verify HEAD`
- `git symbolic-ref -q --short HEAD` (nonzero means detached or unborn)
- `git worktree list --porcelain -z`
- `git status --porcelain=v2 -z --untracked-files=normal -- <path>`

Git documents porcelain status and worktree-list formats as stable for scripts. NUL-terminated records prevent tabs, spaces, newlines, and quoting rules from corrupting path parsing. `rev-parse` path outputs are newline-delimited, so test unusual roots and either parse the single final line conservatively or document a v0 limitation for repository paths containing newline characters.

### Line attribution

Use:

```bash
git blame --line-porcelain -L <line>,<line> -- <repository-path>
```

Running blame against the worktree allows Git to identify an unchanged line in an otherwise dirty file and produces the all-zero/uncommitted attribution for a modified line. Parse the full object ID, original/final line numbers, author/committer data, `previous` metadata when present, and filename. Do not parse human-oriented blame output.

Do not enable `-M` or repeated `-C` in the primary v0 attribution. Those heuristic modes can move attribution to similar or copied text and make `last textual change` less predictable. A later `--trace-moves` mode may expose their output as a separate derived ancestry hint, never silently replace the baseline attribution.

### Commit metadata

Use one NUL-delimited custom record, for example:

```bash
git show -s --no-show-signature \
  --format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%B%x00 \
  <commit>
```

Commit objects cannot contain NUL bytes, making the fields unambiguous. Keep full object IDs and support Git's reported object format instead of assuming 40-character SHA-1.

### Changed paths and relevant diff

Use the blame record's `previous` commit/path when available to choose the parent comparison. Otherwise, for a non-merge commit use its sole parent; for a root commit compare against the empty tree. A blamed merge-resolution line requires testing: select the parent indicated by blame when possible, and report an explicit limitation if a unique responsible parent cannot be derived.

For the selected parent-to-commit comparison:

```bash
git diff-tree -r -z --name-status -M --no-commit-id <parent> <commit>
git diff --no-ext-diff --no-color --find-renames --unified=3 \
  <parent> <commit> -- <relevant-paths...>
```

For a root commit, use `git diff-tree --root` or compare with the object-format-appropriate empty tree resolved by Git. Parse name-status as NUL records, including both source and destination for `R` and `C`. Parse unified hunk headers for locating the target hunk and retain the existing bounded Git hunk representation for the Git report. The correlation target derives bounded fingerprints from it and does not retain Codex patch/source snippets.

`GitHunk.truncated` is a material correlation limitation for any relevant hunk.
An observed candidate may still receive an individual strong band from evidence
that was retained, but Whyline must not return `matched` because another
candidate's direct overlap may exist outside the retained Git evidence. Missing
overlap in a truncated hunk is not evidence of content divergence.

Avoid `git log --follow` in v0. It handles only a single path, remains heuristic, and is the wrong primitive for a one-line current attribution. Blame plus the selected commit diff is sufficient for the vertical slice.

### Git edge cases

- **Renames:** use the blamed filename and rename-aware parent diff. Do not assume the current repository path existed in the blamed commit's parent.
- **Line movement/copying:** baseline blame may identify the refactor or move. Report this honestly as textual attribution; semantic origin is deferred.
- **Merge commits:** never compare only to the first parent by habit. Use blame parent evidence or return an explicit multi-parent limitation.
- **Rebase, amend, squash:** treat current object IDs as facts about current history, not durable external identities. Correlation must not require matching session timestamps or stale SHAs.
- **Shallow or partial clone:** missing parents/objects yield a partial Git report with a clear limitation; do not fetch automatically.
- **Shallow boundary:** when Git hides a commit's parent and exposes it as parentless, do not treat that commit as a root commit; leave the parent comparison unavailable.
- **Replace refs or grafts:** record that analysis reflects the repository's currently visible history. A future diagnostic flag may expose replace refs.
- **Submodules:** a gitlink is not a text file in the superproject. A path inside a checked-out submodule resolves to the submodule repository; the gitlink entry itself is unsupported as a line target.
- **Symlinks:** reject a symlink target that resolves outside the selected worktree; do not let canonicalization silently switch repositories.
- **Unborn HEAD/bare repository:** return a clear unsupported-state error.
- **Path ambiguity:** always pass `--` before paths and never interpolate paths into a shell command.
- **Mailmaps/signatures:** v0 reports raw commit identity fields and does not verify signatures or apply identity inference.

## Agent adapter structure

Keep three Codex-specific concerns together:

1. **Discovery:** locate active and archived transcripts from the effective Codex home and emit opaque references.
2. **Parsing:** stream records, recognize empirically verified schema variants, link tool calls/results, tolerate a partial final JSONL record, and surface coverage diagnostics.
3. **Extraction:** convert recognized Codex events into normalized, source-referenced evidence.

The adapter must not:

- run transcript commands;
- expose raw prompts by default;
- decide that a session caused a commit;
- assume all paths are relative to the current Whyline invocation;
- silently discard unknown record types;
- use `history.jsonl` as provenance evidence; it is an incomplete prompt-bearing index, not a transcript;
- depend on Codex naming in the domain or correlation modules.

Adding another agent later should mean implementing `AgentHistorySource` and its private parser, not changing Git analysis or correlation semantics. Avoid a dynamic plugin system until a second adapter proves what must vary.

## Path to semantic ancestry

Do not build an ancestry graph now. Preserve only the facts a later resolver will need:

- full commit and parent IDs;
- blob ID;
- path and line coordinates in the worktree and blamed commit;
- rename source/destination pairs;
- raw relevant hunks;
- the explicit label `textual attribution`.

Keep `blame-line.ts` behind a narrow `resolveTextualAttribution(location)` boundary, and have the report assemble a list of provenance claims rather than assuming one universal `originCommit` field. A future semantic-ancestry component can append a `semantic origin` claim based on ASTs, similarity, or movement without changing the meaning of the v0 claim.

This is the only future-facing seam justified now. Do not introduce AST interfaces, similarity strategies, graph storage, or confidence models for ancestry in v0.

## Important failure modes

- The Codex store exists but history persistence is disabled or older records were compacted.
- A transcript is being appended and ends with partial JSON.
- A schema variant contains tool calls that the parser does not recognize.
- A session cwd points to a deleted or relocated worktree.
- Two repositories have the same basename and relative paths.
- Several linked worktrees share objects but contain different dirty states.
- A Codex-managed worktree is detached and later deleted.
- A session applies a patch, another session revises it, and a human amends the commit.
- A squash commit combines unrelated sessions.
- The relevant line is context in a commit diff, not an added line in that commit because blame and parent selection were interpreted incorrectly.
- Rename detection chooses or misses a similarity match.
- A merge-resolution line has no single obvious parent comparison.
- Shallow history lacks the blamed parent.
- Filenames include tabs, newlines, leading dashes, non-UTF-8 bytes, or colons.
- Commit messages or transcript output contain terminal escape sequences. Rendering must sanitize control characters.
- Huge tool outputs or prompts exhaust memory. All transcript parsing must stream and cap retained snippets.
- Commands in transcripts contain secrets. Default output should show command classification and safe basename-level details, not raw environment assignments.
- The target changes between validation, blame, and report. Record `HEAD` and target stat/digest before and after analysis; if they differ, abort with `repository changed during analysis` rather than combine inconsistent facts.

## Testing strategy

### Deterministic Git fixtures

Build temporary repositories in tests with fixed author/committer names, emails, timestamps, default branch, object format where available, and disabled user/system config (`GIT_CONFIG_NOSYSTEM`, isolated global config). Use the installed Git CLI to create histories; assert parsed domain objects rather than only terminal snapshots.

Fixture histories should cover:

1. One root commit and one later edit to the queried line.
2. Dirty file with queried line unchanged.
3. Dirty queried line producing uncommitted attribution.
4. Untracked, deleted, binary, symlink, out-of-range, and outside-worktree paths.
5. Rename without edits and rename with edits.
6. Intra-file line movement and copied code, proving baseline attribution behavior.
7. Merge commit with unchanged parent lines and a merge-resolution-only line.
8. Rebased equivalent patch with different object IDs and committer times.
9. Amended commit.
10. Squash commit combining two fixture sessions.
11. Linked worktrees sharing a common Git directory, including detached HEAD.
12. Shallow clone with a missing parent, constructed locally without network.
13. Pathnames with spaces, tabs, Unicode, leading dash, colon, and—where Git/OS permits—newline.
14. SHA-256 repository when the installed Git supports it.
15. Repository mutation between analysis stages, using an injected process boundary.

### Codex adapter fixtures

After preflight, create minimal synthetic JSONL for every observed schema variant. Include:

- complete session with session metadata, command attempts, streamed input, patch attempt/result/change payload, optional transcript Git metadata, and linked tool results;
- session that edits but never commits;
- resumed and compacted session;
- archived session;
- subagent activity;
- failed and interrupted tool calls;
- truncated output and unknown records;
- partial trailing JSONL;
- missing cwd or timestamps;
- misleading same-relative-path session from another repository;
- concurrent sessions touching the same target;
- secrets/control characters to verify redaction and rendering.

Use redacted structures, not copied personal transcript content.

### Correlation table tests

Make the scorer a pure function and use table-driven cases. Assert signals, contradictions, band, ordering, and final selection separately. Required cases include:

- exact repository + observed session-head SHA without patch => not strong;
- exact repository + distinctive structured patch overlap => one strong match;
- same repository + distinctive patch overlap but stale rebased SHA => strong;
- unknown/deleted cwd + session-head target SHA + distinctive patch overlap => historical strong;
- nearest timestamp in wrong repository => excluded;
- same filename and close time only => weak;
- two strong sessions => ambiguous;
- one strong and one plausible => strong selected, plausible retained as alternative;
- one plausible only => no asserted match, displayed as possible;
- transcript unavailable => Git-only success;
- truncated transcript => limitation attached, not silent confidence;
- truncated relevant Git hunk => no `matched` and no inferred divergence from absence of overlap;
- agent patch later changed by a human => plausible or ambiguous, depending on overlap.

### End-to-end CLI tests

Run the packaged CLI against fixture repositories and a fixture Codex home. Snapshot concise text output only after asserting the structured report. Verify exit codes, no-color behavior, control-character sanitization, operation with spaces in paths, and that no Git or transcript command mutates files. Include a spy/fake process runner test proving every Git invocation uses an argv array and belongs to an allowlisted read-only command family.

## Milestone plan

Each slice should be reviewable and independently testable.

### Slice 0: Codex format preflight

- Inspect a consented matrix of local active/archived sessions across relevant Codex surfaces.
- Answer the 20 preflight questions.
- Produce a format matrix, redacted fixture corpus, parser invariants, and scan benchmarks.
- Exit criterion: enough stable discriminators exist to identify sessions, cwd/repository, tool calls/results, file events, and truncation; otherwise reduce v0 Codex support to explicitly verified variants.

### Slice 1: Git-only location report

- Establish Node/TypeScript package conventions and the single CLI entry point.
- Parse and resolve `<file>:<line>`.
- Discover repository/worktree identity and dirty state.
- Parse one-line blame and commit metadata.
- Render a useful Git-only report with factual limitations.
- Exit criterion: root, ordinary, dirty-unchanged, dirty-line, rename, merge, linked-worktree, and malformed-input fixtures pass.

### Slice 2: Relevant commit evidence

- Select the parent relevant to the blamed line.
- Parse rename-aware changed paths and the relevant unified hunk.
- Add blob/hunk facts and mutation-during-analysis protection.
- Exit criterion: renamed, merge-resolution, root, shallow, rebased, and unusual-path fixtures pass without first-parent assumptions.

### Slice 3: Codex adapter

- Implement discovery and streaming parsers only for preflight-verified schema variants.
- Link tool calls/results and extract normalized evidence with source record references; distinguish command attempts, patch attempts, tool-reported patch results, and recovered patch payloads.
- Add unknown/compacted/rollback/abort/truncated/partial-record/changed-during-read diagnostics and safe redaction.
- Exit criterion: all redacted adapter fixtures pass, unsupported variants degrade to diagnostics, and realistic header scans meet the preflight latency target.

### Slice 4: Conservative correlation

- Implement repository eligibility, signal extraction, weighting, confidence bands, and ambiguity rules as pure functions.
- Compare target hunk fingerprints and changed-file sets.
- Integrate staged session summary/evidence loading.
- Exit criterion: the full correlation decision table passes and time-only matches are impossible.

### Slice 5: Integrated provenance report

- Assemble fact, derived, and inferred claims.
- Render matched, ambiguous, plausible-only, unavailable-history, and Git-only outcomes.
- Add full CLI fixture tests, privacy/redaction checks, and performance measurements.
- Exit criterion: `whyline <file>:<line>` produces a concise deterministic report across the acceptance fixture matrix, without writes or network access.

### Slice 6: Release hardening

- Verify the Node 24 and Git 2.31 version floors against the packaged CLI and every command option used.
- Test Linux and macOS path/process behavior. Audit Windows drive/UNC parsing without claiming Windows support.
- Document privacy behavior, known Codex variants, Git limitations, and unsupported inputs.
- Package the CLI and verify installation in a clean environment.
- Exit criterion: repeatable install and smoke test on Linux and macOS.

## Risks / unresolved decisions

1. **Codex transcript instability remains the primary risk.** The completed preflight establishes a narrow 0.142.5–0.147.0 envelope family, but the adapter must remain version-labelled, diagnostic-heavy, and conservative outside the observed variants.
2. **Surface support must be named.** “Codex history” may mean CLI, IDE, desktop app, exec, or imported sessions. v0 should claim only surfaces observed during preflight.
3. **Latency budget is unset.** Choose a target after measuring real history; suggested starting acceptance is under 500 ms for Git-only and under 2 seconds for a warm filesystem with a typical Codex history. These are proposals, not requirements until measured.
4. **The proposed Git 2.31 floor needs CI proof.** Verify `--path-format`, porcelain-v2, `worktree -z`, and object-format behavior on exactly that version; raise the floor if the required machine-readable behavior differs.
5. **Windows is deliberately deferred.** Parsing from the final colon helps with drive letters, but UNC paths, junctions, and Git path encoding require dedicated fixtures before a support claim.
6. **Merge parent selection needs fixture proof.** Blame porcelain's `previous` metadata may not cover every merge-resolution case. v0 should report ambiguity rather than silently choose first parent.
7. **Patch fingerprint thresholds need calibration.** The proposed weights and “two distinctive lines” floor are safe starting points but must be evaluated against redacted real sessions and adversarial fixtures.
8. **Repository relocation loses path identity.** Without a persisted repository ID or remote lookup, old sessions referencing a deleted path may remain unmatched. This is an acceptable local-first v0 limitation.
9. **Transcript privacy requires default minimization.** Do not retain or display user task text, assistant prose, reasoning, tool output, raw commands, compacted summaries, credentials, or repository URLs in normalized evidence. A future explicitly opt-in diagnostic surface would need a separate privacy review.
10. **Author attribution is not causation.** Git's author/committer fields and Codex activity are evidence. The copy should say “Likely related Codex session,” not “Written by Codex,” unless a future stronger provenance mechanism warrants that claim.

## Recommended next action

The Codex adapter foundation, Git-only location/evidence slices, and conservative
committed-location **Git ↔ Codex correlation** are implemented against the
completed redacted fixture corpus. The integrated path keeps uncommitted and
untracked queries Git-only, bounds full extraction at 32 eligible sessions, and
refuses a final match when candidate, evidence, or relevant-hunk coverage is
materially limited. Full evidence is repository-reclassified before projection,
so incompatible or ambiguous cwd-less records cannot contribute an unsupported
match. The remaining next step is release hardening: verify the documented Node
and Git version floors, package the CLI in a clean environment, and retain the
preflight's conservative behavior for unsupported transcript variants.

## Documentation basis

- Git's official documentation defines `--line-porcelain`, NUL-safe diff name formats, stable porcelain status, and `git worktree list --porcelain -z`: <https://git-scm.com/docs>
- The current Codex manual documents state under `$CODEX_HOME`, active sessions under `$CODEX_HOME/sessions`, archived sessions under `$CODEX_HOME/archived_sessions`, history persistence controls, and warns that transcript format is not a stable interface: <https://developers.openai.com/codex/codex-manual.md>

## Exact Git-visible ancestry milestone

The next milestone adds a deliberately narrower ancestry claim alongside the existing textual attribution and Codex correlation. These are three independent evidence domains:

```text
queried location
    ├── baseline Git blame → textual last-touch
    ├── exact Git ancestry → older exact predecessor
    └── Codex correlation → AI provenance for textual last-touch
```

The baseline blame invocation remains unchanged. After it identifies textual commit `T`, path `P`, and the line in `T`, Whyline runs one candidate-only `git blame --line-porcelain -M -C` query. That result is never sufficient by itself. A candidate `A` must be different from `T`, be positively established as a proper reachable ancestor of `T`, and independently match a bounded contiguous block in the `T:P` and `A:path` blobs exactly.

The exact block must contain the queried line, at least two unique lines using Whyline's existing distinctiveness predicate, and at least 40 alphanumeric characters. Whitespace, case, token, edit-distance, fuzzy, semantic, and transformed-code matching are not used. The supported labels are `same-file-move`, `cross-file-move-or-copy`, `renamed-path` when connected rename evidence is explicit, and `unclassified-exact` when no narrower label is safe. Cross-file move and copy are intentionally combined because Git evidence does not always distinguish them.

No exact predecessor is not origin evidence. The default output says only that ancestry was not established, or that Git suggested movement but exact verification was insufficient. It never says “originated here,” “original commit,” or that a commit introduced an idea. Root history stops at `none / root-history-boundary`; incomplete shallow history is `unavailable / missing-history`; missing objects and unresolved merge parents remain typed unavailable outcomes. A fully proven visible shallow predecessor may be shown with a visible-history limitation, but is never called the ultimate origin. Dirty or untracked targets with no committed attribution do not run ancestry.

Normal output is concise and explanation-first:

```text
whyline <file>:<line>
```

Forensic repository state, full commit metadata, changed paths, relevant hunks, detailed Codex evidence, ancestry candidates, proof counts, and limitations are available with:

```text
whyline --details <file>:<line>
```

JSON, ranges, symbols/functions, semantic or fuzzy ancestry, multi-hop ancestry graphs, persistent ancestry indexes, remote metadata, and additional agent adapters remain deferred.
