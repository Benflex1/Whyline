# Correlation hardening architecture

**Status:** implementation-ready architecture decision
**Date:** 2026-08-09
**Baseline:** `a395942a235956f1ec3038cff2642f5d4d6be25b` on
`docs/correlation-hardening-preflight`

## Decision summary

Whyline will keep its current conservative causal contract and change how it
does the work beneath that contract.

1. Live Codex history remains fail-closed. Whyline will not claim an
   invocation-start snapshot. Any observed rollout or discovery-namespace
   mutation is material `changed-during-read` coverage.
2. One complete, stable summary-and-target-relevance scan per discovered ref is
   the first-pass proof boundary. A ref leaves the potentially-strong set only
   after a positive proof that the current `strong` contract is impossible.
3. Summary/relevance scanning, Git classification, and rich projection use
   bounded workers. Scanning and Git have separate limits and separate queues.
   No result depends on task completion order.
4. The milestone adds invocation-local normalized scan reuse, memoization, and
   aggregate telemetry. It adds no persistent index or cross-invocation cache.
5. The first controlled real corpus contains only P1 and P2: one actual
   positive and one actual two-strong-candidate ambiguity. P3-P6 follow only
   after P1/P2 establish the primary path.
6. Preservation of safety semantics is the hard gate. A fresh approximately
   400 MiB benchmark and material latency improvement are required evidence,
   but `<2 seconds` is not a correctness or milestone gate.

The governing invariant remains:

> Prefer no causal answer over a false causal answer.

## Evidence basis

This decision was made against the architecture, transcript preflight,
conservative-correlation design, real-repository validation, and hardening
preflight at the baseline above. The Terra hardening preflight is treated as
measured evidence and a set of recommendations, not as an architecture
authority.

The load-bearing measurement is the approximately 392 MiB profile: 291 complete
summary scans and 966 repository-classification Git calls dominated an 8.858 s
structured analysis, while 32 rich evidence parses consumed only about 361 ms
aggregate parser time. Fifty-six candidates remained eligible, 32 were
extracted, and 24 were correctly omitted with material coverage. Therefore this
design targets scan duplication, Git call multiplication, and unbounded process
fan-out; it does not weaken the rich overlap contract or disguise an omitted
potentially-strong candidate.

## Scope and non-goals

This milestone may change agent-neutral scan contracts, Codex parsing and
projection, the provenance coordinator, concurrency utilities, coverage types,
diagnostic instrumentation, tests, synthetic fixtures, and private validation
runbooks.

It does not change:

- the meaning of Git blame or the selected Git hunk;
- the two-distinctive-line structured overlap floor;
- the requirement that current `strong` include qualifying supported structured
  patch overlap;
- session-head references from context into produced-commit evidence;
- repository mismatch from exclusion into a score;
- the rule that exactly one strong candidate and complete material coverage are
  required for `matched`;
- the rule that two observed strong candidates yield `ambiguous` regardless of
  score;
- privacy-safe renderer wording;
- the 32 potentially-strong rich-projection cap;
- on-demand, local-only operation; or
- the absence of persistent transcript-derived state.

The existing cap remains a bounded-work constant and test seam, not a claim
that 32 is intrinsically optimal. This milestone changes what can safely be
proved before that cap, not the meaning of an omitted uncertain candidate.

## Frozen pipeline

```text
discover refs and start namespace signature
  -> bounded complete summary + target-relevance scan per ref
  -> end namespace check and per-ref stability result
  -> bounded repository / target-reference classification
  -> classify each usable ref:
       incompatible with positive complete proof
       proven not strong
       cannot prove (potentially strong)
  -> deterministically rank the potentially-strong set
  -> bounded rich projection of at most 32 potentially-strong refs
  -> existing pure scoring and contradiction rules
  -> coverage-gated final decision
  -> optional aggregate diagnostic telemetry snapshot
```

Discovery, scanning, classification, proof, projection, scoring, and selection
remain distinct concepts. In particular, `proven-not-strong` is not a weak
score and `cannot-prove` is not evidence that a candidate is strong.

## Decision 1: live-history semantics

### Selected semantic

Retain fail-closed `changed-during-read` semantics for this milestone.

Whyline does not describe a result as complete for a Codex-history snapshot as
of invocation start. A final `matched` result requires all of the following:

- discovery completed without a material store error;
- every ref relevant to uniqueness was read completely;
- each ref's identity, size, and modification signature was unchanged across
  its read;
- the discovered active/archived namespace had the same membership and file
  identities at the closing discovery check as at the opening check; and
- no other material coverage limitation remains.

The closing namespace check is a detection mechanism, not an atomic filesystem
snapshot. It strengthens detection of creation, deletion, and rotation during
analysis, but it does not create an append-only source contract. Whyline makes
no stronger reproducibility claim than the source can support.

Any observed one of the following adds material `changed-during-read` coverage
and prevents `matched`:

- size, modification time, device, or inode changes across a ref read;
- a ref disappears or is replaced;
- an active or archived rollout appears or disappears between opening and
  closing discovery;
- a store changes from readable to unreadable or vice versa during analysis; or
- a cached scan artifact's source signature no longer matches before it is
  consumed.

An observed mutation does not discard already observed evidence. It may leave
an individual candidate strong and it does not prevent an `ambiguous` result
once two strong candidates are positively observed. It does prevent a claim of
unique complete coverage.

### Rejected semantic for this milestone

`complete for the Codex-history snapshot as of invocation start` is rejected.
An initial file size or prefix cannot atomically freeze recursive membership,
file creation/deletion, prefix rewrites, rollout rotation, or the complete
Codex history namespace. The rollout format is not a documented immutable
append-only contract.

Snapshot semantics may be reconsidered only if one of these exact source
contracts exists:

- a source-owned immutable manifest naming every member and immutable byte
  extent at one epoch;
- an OS/filesystem snapshot that covers both stores and is held for the full
  read; or
- a documented writer protocol whose lock/epoch freezes membership and proves
  every selected prefix immutable until the reader releases it.

That future change would require a new coverage status and renderer wording,
not merely suppression of a diagnostic.

## Decision 2: summary-and-target-relevance proof boundary

### Why this boundary is sound

The measured rich parser cost was approximately 361 ms aggregate for 32 refs.
The complete summary byte scan and repeated Git repository classification were
the dominant costs. The useful first pass is therefore a single complete
structured scan that retains the privacy-minimized facts needed both for the
summary and for deciding whether current `strong` remains possible.

The first pass must observe the whole supported record stream. Head-only,
tail-only, filename, timestamp, branch, and session-head shortcuts cannot prove
negative relevance.

### Typed agent-neutral scan contract

The authoritative contract for this milestone is:

```ts
type AgentRelevanceCoverageReason =
  | "changed-during-read"
  | "partial-record"
  | "corrupt-record"
  | "material-compaction"
  | "material-rollback-or-abort"
  | "unsupported-relevance-record"
  | "unlinked-patch-result"
  | "unclassified-patch-change"
  | "missing-effective-cwd"
  | "retention-limit"
  | "unreadable-transcript";

interface AgentSourceSignature {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeNs: bigint;
}

interface AgentRelevanceCoverage {
  readonly status: "complete" | "limited";
  readonly reasons: readonly AgentRelevanceCoverageReason[];
}

interface AgentCorrelationEvidenceProjection {
  /** Only evidence kinds consumed by the current correlation contract. */
  readonly evidence: readonly AgentEvidence[];
  readonly unknownRecordCount: number;
}

interface AgentSummaryRelevanceScan {
  readonly ref: AgentSessionRef;
  readonly summary: AgentSessionSummary;
  readonly correlationEvidence: AgentCorrelationEvidenceProjection;
  readonly relevanceCoverage: AgentRelevanceCoverage;
  readonly bytesRead: number;
  readonly recordsSeen: number;
  readonly sourceSignature: AgentSourceSignature | null;
}

interface AgentHistorySource {
  readonly id: string;
  discover(
    context?: AgentHistoryDiscoveryContext,
  ): AsyncIterable<AgentSessionRef>;
  discoverWithDiagnostics?(
    context?: AgentHistoryDiscoveryContext,
  ): Promise<AgentHistoryDiscoveryResult>;
  scanSummaryAndRelevance(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ): Promise<AgentSummaryRelevanceScan>;
}
```

`AgentSourceSignature` is an invocation-local read/cache token. It is never
rendered, serialized, persisted, or placed in ordinary report models. An
implementation may use a number/string representation for nanoseconds if the
Node filesystem API requires it; equality semantics, not the representation,
are fixed.

`correlationEvidence` contains only evidence consumed by the current scorer:
structured patch attempts/results and normalized commit references. It omits
commands, streamed input, MCP operations, prompts, prose, reasoning, and tool
output because none can affect the current correlation result. Patch payloads
are reduced during the stream to the existing bounded, non-reversible
fingerprints, numeric hunk ranges, operation kind, result linkage/success,
effective cwd, record order, and normalized path facts. Raw patch text is not
retained after the record is processed.

The Codex source performs this scan once. Rich projection consumes the scan
artifact; it does not reopen the rollout. The old `readSummary` and
`extractEvidence` methods may remain temporarily as test/backward-compatibility
wrappers, but `correlateCodex` must not call them on the new Codex path. They are
not the milestone's authoritative execution path.

### Relevance coverage

`complete` means all of the following are true:

- the file was readable and stable before/after the complete stream;
- every physical record was handled within the supported size bounds;
- session metadata and all supported effective-cwd transitions were
  consistently classified;
- every record shape that could contain a supported patch call/result was
  recognized;
- patch call/result linkage and reported-success state were classified;
- every successful supported patch change had a classified operation and path
  shape; and
- no compaction, rollback, abort, retention, corrupt/partial record, or
  unsupported relevance-bearing shape can hide a competing supported patch.

Known message, reasoning, token, command, output, world-state, and other closed
non-patch record shapes do not make relevance coverage limited merely because
their sensitive content is ignored. An unknown discriminator does make it
limited when the parser cannot positively establish that it is incapable of
carrying patch/cwd/coverage semantics. This distinction must be table-tested by
record discriminator; it must not be inferred from a generic unknown count.

This coverage status answers whether a negative relevance proof is available;
it does not replace the existing candidate-coverage materiality rules. For
example, any compaction prevents a negative proof, while a compaction before a
later complete direct patch may remain informational for that positively
observed candidate under the existing chronology rule. `changed-during-read`,
corrupt/partial relevant data, and other diagnostics that can hide a competing
candidate remain material as they are today.

### Typed proof result

After repository and target-path classification, every usable ref receives one
of these results:

```ts
type ProvenNotStrongReason =
  | "no-successful-supported-patch"
  | "successful-supported-patch-paths-disjoint";

type CannotProveReason =
  | "potentially-relevant-supported-patch"
  | "repository-identity-unknown"
  | "path-classification-unknown"
  | "relevance-coverage-limited"
  | "payload-or-hunk-inconclusive";

type CandidateStrongPossibility =
  | {
      readonly state: "excluded";
      readonly reason: "repository-incompatible";
    }
  | {
      readonly state: "proven-not-strong";
      readonly reason: ProvenNotStrongReason;
    }
  | {
      readonly state: "cannot-prove";
      readonly reasons: readonly CannotProveReason[];
    };
```

The result is about the current `strong` contract only. `excluded` is reserved
for positive repository incompatibility; it remains distinct from a negative
content proof. Neither result is a confidence band, causal finding, or statement
that a session is unrelated. A proven-not-strong session may still have weak or
plausible commit-level signals. The normalized first-pass facts may be passed to
the existing pure scorer when needed to preserve those alternatives; the proof
only removes the session from the set that can threaten uniqueness as a strong
candidate.

### Positive proofs of not strong

Only this repository exclusion and these two negative proofs are authorized in
the first milestone.

#### 1. Repository incompatible exclusion

The ref is excluded only when complete, stable cwd/evidence coverage positively
establishes that every correlation-relevant context belongs to a different Git
common directory and no cwd-less or unresolved relevant evidence can belong to
the target repository.

An explicit evidence record with a known incompatible cwd is always excluded
from projection. Whole-session exclusion additionally requires complete
coverage of context changes. A partial or compacted session with only an
observed incompatible cwd is `cannot-prove`, because an unobserved context
transition could matter.

#### 2. No successful supported patch

The ref is proven not strong when relevance coverage is complete and the entire
stable scan contains no exactly linked, tool-reported-successful patch result in
a supported structured patch shape.

Failed attempts, patch attempts without a linked successful result, commands,
time, branch, and session-head context cannot satisfy current `strong`. An
unlinked, unsupported, malformed, truncated, or coverage-ambiguous patch result
prevents this proof; it is not counted as absence.

#### 3. All successful supported patch paths are disjoint

The ref is proven not strong when relevance coverage is complete and stable,
and every path (including `movedFrom`) of every successful supported structured
patch result is safely normalized and classified as disjoint from the complete
target alias set.

The target alias set is the transitive closure of:

- the current target path;
- the blamed historical path; and
- both sides of every connected rename/change pair in `changedPaths`.

Safe path classification requires a structured effective cwd at the evidence
record, canonical current/linked/common-directory mapping where available, and
no unresolved absolute, outside-root, deleted-unmapped, or cwd-less path. One
unknown path makes the entire ref `cannot-prove`.

### Cannot prove

Every other case is `cannot-prove` and remains in the potentially-strong set.
In particular, none of these is a negative proof:

- exact, stale, nonmatching, ambiguous, or unresolvable session-head context;
- time distance or timestamp absence;
- branch;
- root/subagent/fork relationship;
- basename, relative filename coincidence, or source-path ordering;
- partial, compacted, rolled-back, aborted, corrupt, retained-limited, or
  changed-during-read state;
- unknown/deleted repository identity;
- cwd-less or unsafely normalized patch paths;
- unsupported or incomplete relevance coverage;
- a target-related result with missing/truncated payload;
- one distinctive line;
- non-overlap or hunk distance; or
- absence of overlap when relevant Git or patch material is truncated.

Some of these facts may rank or score a fully projected candidate. They cannot
remove it from uniqueness coverage.

This milestone deliberately does not add other logically possible negative
proofs. Expanding the closed `ProvenNotStrongReason` union requires a new design
review and adversarial proof tests.

### Coverage and final selection

`CorrelationCoverage` is widened to make the proof boundary observable:

```ts
interface CorrelationCoverage {
  readonly status: "complete" | "limited" | "unavailable";
  readonly discoveredRefs: number;
  readonly usableSummaryRefs: number;
  readonly incompatibleRefs: number;
  readonly provenNotStrongRefs: number;
  readonly potentiallyStrongRefs: number;
  readonly fullyProjectedRefs: number;
  readonly omittedPotentiallyStrongRefs: number;
  readonly limitations: readonly CorrelationLimitation[];
}
```

The current `summaryEligibleRefs`, `fullyExtractedRefs`, and
`omittedEligibleRefs` names are replaced rather than overloaded. Renderers may
continue showing only fixed human coverage descriptions.

The uniqueness rule is:

```text
matched only if
  exactly one fully assessed candidate is strong
  and every discovered ref is positively incompatible,
      proven not strong, or fully projected
  and omittedPotentiallyStrongRefs == 0
  and no material source, candidate, or Git coverage limitation exists
```

If more than 32 refs remain potentially strong, the deterministic first 32 are
projected, the remainder increments `omittedPotentiallyStrongRefs`, and
`candidate-cap` remains material. A proof-derived omission never increments the
cap limitation. Two positively observed strong candidates still yield
`ambiguous` even if additional uncertainty exists, because no unique candidate
is asserted.

## Decision 3: bounded concurrency and latency

### Pools and gates

The coordinator uses three bounded execution domains:

1. **Summary/relevance scan pool.** Opens and streams rollout files. It performs
   parser work and no Git subprocess work.
2. **Git classification gate.** Owns every Git process used for historical
   repository classification, target-reference resolution, and path projection.
   No helper may bypass this gate or create nested unbounded `Promise.all`
   process fan-out.
3. **Rich projection pool.** Projects at most 32 potentially-strong scan
   artifacts into scorer inputs. Any Git work requested by a projection still
   passes through the shared Git gate.

Discovery remains a bounded directory traversal and does not launch a task per
ref. Pure scoring remains synchronous and deterministic.

Scanning and Git classification have separate limits because their resource
profiles differ and because one combined limit would conceal process pressure
behind file I/O. The first implementation runs the main phases in order—scan,
then classification/proof, then rich projection—so the benchmark can attribute
queue and work time without uncontrolled cross-stage overlap.

### Default limit policy

Limits are derived once per invocation from Node's available parallelism and
the number of jobs:

```text
P = max(1, availableParallelism())
scan workers       = min(scan jobs, P)
Git process slots  = min(Git jobs, max(1, floor(P / 2)))
projection workers = min(projection jobs, P)
```

The Git formula reserves host capacity for the Node scanner/coordinator and
avoids equating cheap async tasks with heavyweight child processes. It is an
initial resource policy, not a performance truth. The limits are injectable in
tests and benchmark builds, but are not CLI flags or environment configuration
in this milestone. Any post-benchmark tuning must record queue, process, and
wall measurements rather than replace the formula with an unexplained constant.

The existing value 32 is not used as a worker count. It remains only the
potentially-strong projection cap.

### Git call reduction and invocation memoization

Bounded concurrency alone could make the measured 966 Git calls slower. The
implementation must also avoid repeated classification:

- classify paths already canonically inside the current/listed worktrees
  without spawning Git;
- memoize historical directory resolution by canonical directory plus the
  invocation's target common-Git-directory identity;
- memoize commit-reference resolution by object format, target commit, reference
  kind, and normalized reference;
- coalesce concurrent identical lookups into one in-flight promise; and
- when a Git invocation is required, return the common directory and worktree
  root in one classification operation where the existing read-only Git
  command contract permits it.

Failed or unknown resolutions may be memoized only for the invocation and only
as `unknown`; they never become an incompatibility proof.

### Deterministic semantics

Concurrency changes latency only. It does not change results.

- Opening discovery order is normalized by the existing opaque source-path
  lexical key before work is assigned.
- Each ref retains its normalized ordinal through all stages.
- Workers write results into ordinal slots; completion order is ignored.
- Ranking remains target reference, repository class, time, then opaque lexical
  order.
- Proof counts, limitations, candidates, alternatives, and telemetry reductions
  are folded in ordinal order.
- Equal inputs must produce byte-for-byte equal structured results regardless of
  injected delays or worker limits.

No “first winner,” time-based cancellation, or top result observed during the
scan may affect selection.

### Failure propagation

Expected source failures are normalized and analysis continues conservatively:

- discovery failure maps to `unavailable` or `limited` as today;
- one scan failure produces an unusable summary or limited relevance coverage,
  adds material coverage, and cannot be a negative proof;
- Git nonzero/error maps to `unknown`, never `incompatible`;
- projection failure retains the ref as omitted/uncertain with a material
  limitation; and
- observed mutation maps to material `changed-during-read`.

An internal pool invariant failure, inability to create the bounded scheduler,
or loss of the process boundary is an operational failure and aborts the
correlation operation. It is not silently converted into a complete `none`.

After a fatal abort, queued work is not started. In-flight read streams are
closed and in-flight Git processes receive the shared abort signal. Expected
per-ref failures do not cancel other refs because their aggregate coverage is
still useful.

### Performance objective

Safety preservation is the hard gate. After implementation, rerun a fresh
approximately 400 MiB benchmark on a quiescent retained-history copy using the
same target, machine, Node/Git versions, cache condition, and concurrency policy
for baseline and new code.

Record at least five warm-cache runs for each version and compare medians using
the fixed telemetry below. The performance objective is at least a 20% reduction
in median total correlation time, with the stage metrics explaining the change.
This is an objective to validate the architecture, not permission to weaken a
safety gate. If it is missed, record the result and revisit scan bytes/Git call
architecture before changing confidence, coverage, or persistence.

The long-term interactive target remains `<2 seconds` for a typical warm local
history. This milestone does not promise that a full on-demand 400 MiB scan can
reach it.

## Decision 4: invocation-local telemetry

Telemetry exists only as an explicitly requested diagnostic/test snapshot. It
is not printed in normal human CLI output and is not persisted or transmitted.
Names, units, and meanings are fixed below.

| Fixed metric name | Unit | Meaning |
| --- | ---: | --- |
| `whyline.correlation.discovered_refs` | count | Opening discovery ref count. |
| `whyline.correlation.bytes_scanned` | bytes | Transcript bytes consumed by first-pass scans. |
| `whyline.correlation.summary_relevance.wall_ms` | ms | First enqueue through final scan completion. |
| `whyline.correlation.summary_relevance.queue_ms_sum` | ms | Sum of enqueue-to-start time for scan jobs. |
| `whyline.correlation.summary_relevance.queue_ms_max` | ms | Maximum enqueue-to-start time for one scan job. |
| `whyline.correlation.summary_relevance.work_ms_sum` | ms | Sum of active scan job time. |
| `whyline.correlation.candidates.current_worktree` | count | Refs classified current worktree. |
| `whyline.correlation.candidates.linked_worktree` | count | Refs classified linked worktree. |
| `whyline.correlation.candidates.same_common_directory` | count | Refs classified same common directory. |
| `whyline.correlation.candidates.historical_commit_anchored` | count | Refs classified historical anchored. |
| `whyline.correlation.candidates.unknown` | count | Refs with unknown repository identity. |
| `whyline.correlation.candidates.incompatible` | count | Refs positively classified incompatible. |
| `whyline.correlation.candidates.unsupported_summary` | count | Refs without a usable structured summary. |
| `whyline.correlation.proven_not_strong` | count | All refs with a positive not-strong proof. |
| `whyline.correlation.potentially_strong` | count | All refs whose strong status cannot be disproved. |
| `whyline.correlation.git_classification.calls` | count | Spawned classification/reference/projection Git processes. |
| `whyline.correlation.git_classification.wall_ms` | ms | First Git enqueue through final Git completion. |
| `whyline.correlation.git_classification.queue_ms_sum` | ms | Sum of Git enqueue-to-slot time. |
| `whyline.correlation.git_classification.queue_ms_max` | ms | Maximum Git enqueue-to-slot time. |
| `whyline.correlation.git_classification.process_ms_sum` | ms | Sum of spawn-to-close process durations. |
| `whyline.correlation.full_evidence.candidates` | count | Potentially-strong refs receiving rich projection. |
| `whyline.correlation.full_evidence.bytes_read` | bytes | Additional transcript bytes read after first pass; expected zero on the Codex path. |
| `whyline.correlation.full_evidence.read_ms_sum` | ms | Additional transcript read time after first pass; expected zero on the Codex path. |
| `whyline.correlation.full_evidence.wall_ms` | ms | First projection enqueue through final projection completion. |
| `whyline.correlation.full_evidence.queue_ms_sum` | ms | Sum of projection enqueue-to-start time. |
| `whyline.correlation.full_evidence.queue_ms_max` | ms | Maximum projection queue time. |
| `whyline.correlation.full_evidence.work_ms_sum` | ms | Sum of active projection time. |
| `whyline.correlation.total_ms` | ms | Discovery start through final correlation result. |

Material limitation counters use exactly
`whyline.correlation.material_coverage.<kind>`, where `<kind>` is one member of
the closed `CorrelationLimitationKind` union. Every union member has a
predeclared zero-default counter; arbitrary diagnostic text cannot create a
metric name. At minimum the current kinds—`discovery-unavailable`,
`discovery-limited`, `unsupported-summary`,
`unresolved-repository-candidate`, `candidate-cap`, `summary-coverage`,
`partial-transcript`, `corrupt-transcript`, `changed-during-read`,
`truncated-git-hunk`, `truncated-patch-payload`, `material-compaction`, and
`material-rollback-or-abort`—remain fixed.

Queue time is always recorded at the scheduler boundary. Work time starts only
after a slot is granted. Git process time starts after spawn and ends at close;
it is intentionally different from Git queue time and Git stage wall time.
Aggregate process/work sums may exceed wall time under concurrency and must be
labelled as sums.

The telemetry value type is `Readonly<Record<CorrelationMetricName, number>>`.
It accepts numbers only. No tags, free-form labels, paths, source kinds, session
IDs, transcript-derived tokens, repository names, branch names, errors, or
diagnostic details are allowed. A test must recursively reject every non-fixed
key and every non-number value.

## Decision 5: indexing, caching, and privacy

### No persistent index

No persistent transcript index or cache is authorized in this milestone. The
implementation must not write transcript-derived data to the repository,
Codex home, operating-system cache directories, logs, temp files, SQLite, or
another service.

Allowed invocation-local state is:

- aggregate numeric telemetry;
- normalized summary/relevance scan artifacts;
- bounded non-reversible patch fingerprints and numeric hunk ranges;
- path/repository and commit-reference memoization; and
- a scan-artifact cache keyed by the stable source signature.

The cache key is `(device, inode, size, mtimeNs)` plus adapter ID. Cache reuse is
allowed only after a stable complete read and only during the same top-level
Whyline invocation. The source signature must be revalidated before the cached
artifact drives final selection. A mismatch is material
`changed-during-read`; it is not a cache miss followed by a silent reread.

Forbidden persistent or cross-invocation data includes:

- transcript paths or filenames;
- session IDs or parent/fork IDs;
- prompts, messages, reasoning, or summaries;
- commands, arguments, environment values, or tool output;
- raw patch text or source snippets;
- repository URLs, repository names, or remote identifiers;
- absolute working directories;
- source record excerpts; and
- any derived correlation metadata that links a transcript/session to a
  repository, target, commit, or fixture across invocations.

The normal renderer remains fixed-text and sanitized. Telemetry is available
only through an explicit injected collector or diagnostic API used by tests and
the benchmark harness. It is not added to ordinary `WhylineReport` output.

Persistent indexing may be reconsidered only after the new one-pass design has
a fresh 400 MiB profile and a separate privacy/invalidation design.

## Controlled real P1/P2 corpus

### Ownership and isolation

The user/owner conducting validation is the retention owner and records consent
for every retained run. Original rollout files:

- remain outside the Whyline repository in a permission-restricted local
  directory;
- remain local/private and outside sync/backup where feasible;
- use a fresh dedicated `CODEX_HOME` and a disposable validation repository;
- are produced with no remotes, network access, personal-home access, secret
  mounts, or personal credentials;
- contain only deliberately invented validation content;
- are never committed, uploaded, pasted into reports, or copied into fixtures;
  and
- expire when the sanitized derived fixtures and aggregate results are accepted
  or after seven days, whichever occurs first.

The retention owner deletes the originals at expiry and records only the
aggregate fact and date of deletion. Any extension requires a new explicit
owner decision; silent rollover is forbidden.

A private registry may exist only outside the Whyline repository and only until
expiry. It may contain opaque run labels, scenario, Codex version/schema,
fixture version, consent state, and expiry/deletion state. It must not contain
session IDs, transcript filenames/paths, prompts, commands, patch text,
repository paths/URLs, or source-session identifiers. No private registry key
is copied into repository fixtures or reports.

### P1 — controlled real positive

1. Create a fresh private validation repository and dedicated Codex home.
2. Start one actual Codex session on a supported surface/version that emits the
   structured `apply_patch` call/result shape.
3. Apply one patch containing at least two distinctive invented lines in the
   queried target hunk.
4. End/quiesce the session. From a non-Codex shell, verify no rollout writer is
   active.
5. Have the human commit exactly the resulting working-tree change, with no
   later source edit.
6. Run the real `CodexHistorySource` through the full Whyline pipeline against
   one of the distinctive committed lines.

Required structured outcome: `matched`, exactly one strong candidate, complete
safe coverage, zero omitted potentially-strong refs, and no material
limitation. Session-head equality is not required and is not the causal proof.

### P2 — controlled real ambiguity

1. Use a fresh P2 validation repository and dedicated Codex home containing
   exactly the two scenario sessions.
2. Run two separate actual Codex sessions. Each must independently produce an
   exactly linked, successful supported structured patch result.
3. Session A adds at least two distinctive invented lines and session B adds at
   least two different distinctive invented lines. Both changes must survive in
   one final Git hunk containing the queried line.
4. No later patch may create active structured divergence for either session.
5. After both sessions are quiescent, the human commits the aggregate resulting
   change without source edits.
6. Run the actual `CodexHistorySource` and full pipeline from a non-Codex shell.

Before accepting the result, assert each session in isolation meets the current
individual `strong` contract against the final target hunk. Then assert the
combined result is `ambiguous`, with two strong candidates, complete coverage,
and no candidate-cap or incomplete-coverage limitation.

Mentions, time proximity, shared filenames, subagent ancestry, omitted
candidates, and deliberately broken coverage do not satisfy P2.

### Derived repository artifacts

After observing P1/P2, the repository may retain only:

- minimal sanitized synthetic JSONL fixtures reproducing the observed record
  shapes and linkage;
- deliberately invented source/patch text needed by parser fixtures, or
  non-reversible fingerprints in correlation fixtures;
- aggregate expected/actual status and coverage outcomes; and
- non-sensitive Codex version/schema information.

Replace session IDs, timestamps, cwd values, parent/fork IDs, call IDs, and
record metadata with synthetic values. Remove prompts, reasoning, commands,
outputs, repository URLs, original paths, and raw rollout material. Repository
artifacts must not contain a label or identifier that can be joined back to an
original source session.

## Existing modules and interfaces expected to change

### Agent/Codex boundary

- `src/agents/agent-history-source.ts`
  - add the typed summary/relevance scan, coverage, source-signature, and
    correlation-evidence projection contracts;
  - make `scanSummaryAndRelevance` the authoritative staged source operation;
  - retain old read/extract methods only as temporary compatibility wrappers.
- `src/agents/codex/parse-transcript.ts`
  - return byte counts and stable before/after signatures;
  - classify relevance-bearing versus closed irrelevant unknown shapes;
  - preserve fail-closed diagnostics and complete effective-cwd tracking.
- `src/agents/codex/extract-evidence.ts`
  - fold current patch/reference extraction into the one-pass scan visitor;
  - expose no raw payload after normalized fingerprints are derived;
  - project from the scan artifact without reopening the transcript.
- `src/agents/codex/source.ts`
  - implement `scanSummaryAndRelevance` and invocation-scoped artifact reuse.
- `src/agents/codex/discover.ts`
  - expose an opening/closing namespace membership signature or equivalent
    stable comparison input without treating filenames as session identity.
- `src/agents/codex/index.ts`
  - export only the new public agent-neutral scan surface needed by callers.

### Provenance orchestration and Git boundary

- `src/provenance/correlate-codex.ts`
  - replace broad and nested `Promise.all` fan-out with bounded pools/gates;
  - consume one scan artifact per ref;
  - separate repository classification, proof classification, potentially-
    strong ranking, and projection;
  - add invocation-only memoization and the widened coverage counts;
  - preserve the existing pure scorer and selection call.
- `src/provenance/resolve-commit-reference.ts`
  - run through the shared Git gate and invocation memoization.
- `src/git/repository-context.ts` and, if needed,
  `src/git/git-path.ts`
  - expose pure current/listed-worktree containment helpers so known paths avoid
    Git subprocesses.
- `src/git/git-process.ts`
  - accept shared cancellation/gating instrumentation without changing the
    argv-only, read-only command boundary.
- new focused utility modules, expected as
  `src/provenance/bounded-work-pool.ts` and
  `src/provenance/correlation-telemetry.ts`, own scheduling and fixed aggregate
  metrics respectively. They must remain correlation-internal, not a general
  framework.

### Correlation domain and reporting

- `src/correlation/model.ts`
  - add `CandidateStrongPossibility` and the widened explicit coverage counts.
- `src/correlation/build-candidates.ts`
  - distinguish incompatible, proven-not-strong, and cannot-prove states;
  - never turn uncertainty into ineligibility without a material limitation.
- `src/correlation/correlate.ts`
  - apply uniqueness over the fully covered potentially-strong set while
    preserving the current scoring/ambiguity semantics.
- `src/correlation/score-candidate.ts` and
  `src/correlation/patch-overlap.ts`
  - no confidence or overlap-rule change is expected; add only contract plumbing
    or assertions needed to prove unchanged behavior.
- `src/cli/render-correlation.ts`
  - map any new coverage kind to fixed text only if necessary; do not render
    metrics or proof-reason internals.
- `src/provenance/model.ts`
  - do not add telemetry to the ordinary report; add only an explicit diagnostic
    return seam if orchestration requires it.

### Tests and validation documentation

- `test/codex-history.test.ts` covers one-pass extraction, byte/signature
  accounting, relevance coverage, mutation, and cache reuse.
- `test/provenance-correlation-flow.test.ts` covers bounded fan-out, Git
  memoization, proof/cannot-prove staging, cap behavior after proof, namespace
  changes, deterministic completion ordering, and failure propagation.
- `test/correlation-decision-table.test.ts` preserves every existing confidence
  and ambiguity row and adds proof-boundary table cases.
- `test/correlation-e2e.test.ts` proves synthetic P1/P2 equivalents and no
  transcript reread on the Codex path.
- `test/fixtures/codex/README.md` documents only sanitized derived shapes.
- a new validation runbook/report under `docs/validation/` records the P1/P2
  protocol and aggregate outcomes without source-session identifiers.

No production code is changed by this design document.

## Milestone acceptance criteria

### Hard safety gates

All must pass:

1. Every existing test remains green and the existing correlation decision
   table is unchanged in outcome.
2. A stale/nonmatching session-head, time, branch, relationship, basename,
   partial state, unknown/deleted repository, or incomplete relevance scan is
   never a not-strong proof.
3. Known incompatible evidence is excluded; unknown resolution is retained.
4. An omitted potentially-strong ref adds material `candidate-cap` and blocks
   `matched`.
5. Observed file or namespace mutation adds material `changed-during-read` and
   blocks `matched`.
6. Qualifying `strong` still requires supported successful structured patch
   overlap with at least two distinctive lines and no active contradiction.
7. Two strong candidates always return `ambiguous`; one strong returns
   `matched` only with complete coverage.
8. Worker counts never exceed their injected limits, including nested path and
   reference work. Results are identical under worker limits 1 and the default,
   and under adversarial completion reordering.
9. The Codex correlation path reads each stable transcript at most once.
10. Telemetry contains only the fixed numeric keys; normal CLI output contains
    no metrics or new transcript-derived material.
11. No implementation or test reads real personal Codex history automatically,
    writes transcript-derived persistent state, executes transcript commands,
    uses network access, or weakens Git's read-only argv boundary.

### Controlled validation gates

- P1 produces the required actual-source `matched` result with complete safe
  coverage.
- P2 produces the required actual two-strong-candidate `ambiguous` result with
  complete safe coverage and no cap-derived ambiguity.
- Sanitized derived fixtures and the aggregate validation report are reviewed
  and accepted.
- Original rollout files are then deleted by the retention owner no later than
  the seven-day expiry.

### Performance evidence

- Capture a fresh approximately 400 MiB baseline and post-change benchmark with
  the fixed aggregate telemetry.
- Report discovered refs, bytes, all queue/work/wall metrics, classification
  counts, Git calls/process time, proof counts, projection counts/bytes, material
  limitations, and total time.
- Seek at least 20% lower median total time over five comparable warm runs.
- Treat safety failures as release blockers. Treat a missed performance
  objective as an architecture follow-up requiring explanation and measurement,
  not as permission to lower a confidence or coverage gate.

## Explicitly deferred

- Invocation-start snapshot semantics or any relaxation of
  `changed-during-read`.
- Persistent indexes, disk caches, cross-invocation metadata, and index privacy,
  invalidation, relocation, or deletion policy.
- Raising/removing the 32 potentially-strong projection cap.
- Lowering fingerprint thresholds, accepting session-head as causal evidence,
  or changing confidence weights/bands to improve recall.
- A binding `<2 seconds` requirement for an on-demand full approximately 400 MiB
  history scan.
- P3 amended/rebased, P4 human-final-edit, P5 linked/deleted worktree, and P6
  deleted-unmapped worktree controlled validation. These are the next corpus
  expansion after P1/P2 passes.
- Additional Codex schema/surface claims beyond empirically supported variants.
- Persistent or normal-output telemetry, remote telemetry, and free-form metric
  labels.
- Semantic ancestry, split authorship, LLM/embedding matching, additional agent
  adapters, daemon/index services, IDE/web surfaces, and remote repository
  lookup.

## Implementation handoff

Implement in this order: typed scan/coverage contracts; one-pass Codex scan;
bounded scheduler and Git gate; invocation memoization; proof classification;
coverage/scoring integration; fixed telemetry; synthetic tests; P1/P2 private
validation; fresh 400 MiB benchmark.

Do not begin a later deferred capability during this milestone. A completed
handoff consists of the hard safety gates, accepted P1/P2 aggregate evidence,
privacy review, and recorded benchmark—not a new causal feature claim.
