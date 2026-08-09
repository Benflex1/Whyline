# Correlation hardening preflight

**Date:** 2026-08-09
**Scope:** read-only investigation after real-repository validation. No production
code, transcript data, or Git history was changed.

## Executive recommendation

Do one small hardening milestone before any confidence or cap change:

1. add a consented, isolated real-session corpus and validate one `matched` and
   one `ambiguous` outcome against its original rollout files;
2. add invocation-local, aggregate stage metrics and an on-demand *target
   relevance scan* that can safely prove some complete sessions cannot be
   `strong`;
3. keep the cap, current confidence gates, omitted-candidate limitation, and
   fail-closed active-read semantics unchanged until a snapshot contract is
   explicitly selected.

This advances real-positive validation and removes needless full-evidence work
without treating an omitted potentially-strong session as unrelated. It is not
a proposal to raise the cap or choose a top-N result.

## Evidence and measurement method

The required architecture, transcript preflight, conservative-correlation
design, and prior real-repository validation were read. The current code was
traced from `discoverCodexSources` through `correlateCodex` and the pure
correlator. A temporary in-memory wrapper around the existing history source
and Git runner collected only counters, file sizes, and timings. It emitted no
transcript content, paths, session IDs, patch material, commands, or output.

The profile queried `src/cli/render-correlation.ts:1` in this repository. The
live store changed between the earlier validation and this measurement, so the
counts below are an observation at sampling time, not a replacement for the
289-file baseline.

| Metric | Observed |
| --- | ---: |
| Readable rollout files / bytes | 291 / 411,058,543 bytes (392.0 MiB) |
| End-to-end structured analysis | 8.858 s |
| Discovery wall time | 43 ms |
| Summary calls / concurrent wall span / aggregate read time | 291 / 4.244 s / 676.918 s |
| Repository-classification Git calls / wall span / aggregate process time | 966 / 8.812 s / 100.051 s |
| Target-reference Git calls / aggregate process time | 2 / 9 ms |
| Full-evidence parser calls / parser aggregate time | 32 / 361 ms |
| Full-evidence stage span (parser plus reclassification, path projection, and Git) | 4.363 s |
| Renderer time / output bytes | 0.814 ms / 4,395 bytes |
| Eligible / extracted / omitted | 56 / 32 / 24 |

The wall spans overlap: all summaries are launched concurrently, and their Git
classification overlaps both tail summaries and later evidence work. Therefore
the aggregate CPU/process times must not be added to wall time. The useful
conclusion is nevertheless clear: directory traversal is negligible; complete
summary streaming and per-session Git resolution dominate the critical path.

The same aggregate summary pass found all 291 sessions had structured cwd data;
56 had at least one cwd under the current Whyline worktree. All 291 had usable
structured session IDs. Eighty-six were partial and 86 were marked subagent.

## Exact candidate-cap saturation path

The current route is:

```text
recursive sessions + archived_sessions discovery
  -> readSummary for every ref (complete JSONL stream)
  -> classify every structured cwd with Git common-directory resolution
  -> resolve summary session-head reference
  -> eligibility
  -> rank [target head, repository match, time, opaque source order]
  -> first 32 eligible refs receive extractEvidence
  -> omitted eligible refs add material candidate-cap coverage
```

`readSummary` is not a short header read. It streams every line so that the
summary retains the last valid timestamp, every supported cwd transition,
compaction/rollback/abort diagnostics, unknown-record accounting, a valid final
record check, and before/after file signatures. Its lightweight parsing avoids
full JSON for most records, but still consumes the complete 392 MiB byte
stream.

For Whyline, every session with a structured cwd under the worktree becomes a
positive `current-worktree` repository match. In `buildCandidateInput`, a
positive repository match and a usable session ID is sufficient for eligibility;
there is no summary-level requirement for a patch, target path, hunk, or close
time. Thus the prior 55 sessions (56 in the live measurement) survive. The
current summary has no normalized patch-result/path information with which to
distinguish target relevance. Ranking can order them, but it cannot prove that
rank 33+ cannot contain a qualifying two-distinctive-line structured overlap.

The cap is therefore behaving correctly: 23 sessions in the earlier validation
(24 at this live sample) are omitted, `candidate-cap` is material, and a lone
strong inspected candidate cannot yield `matched`.

## Pre-extraction discriminators

| Candidate fact available before full correlation | Classification | Reason |
| --- | --- | --- |
| Structured cwd resolves to a different Git common directory | **Safely exclude** | Known repository incompatibility cannot be repaired by matching relative paths or time. |
| Missing/conflicting structured session identity | **Not a candidate; material coverage** | It cannot safely be identified or selected. It must remain visible as unsupported-summary coverage. |
| Unknown/deleted cwd without a uniquely resolved target commit anchor | **May avoid extraction, but material coverage** | Existing semantics permit omission only with `unresolved-repository-candidate`; it does not prove irrelevance. |
| Exact target session-head reference | **Ranking only** | It is HEAD context, not a produced-commit fact or patch proof. |
| Nonmatching/stale session-head reference | **Unsafe for exclusion** | Rebase/amend/squash workflows deliberately permit a stale SHA plus matching structured patch evidence. |
| Time distant from the commit | **Unsafe for exclusion** | Delayed commits and rewritten history make time non-causal. |
| Subagent/root relationship, branch, basename, or relative filename | **Unsafe for exclusion** | None establishes identity or rules out a target patch. |
| Partial/compacted/aborted history | **Unsafe for exclusion** | It limits selection coverage; it does not prove a session could not contain relevant evidence before/after the gap. |
| Complete, stable structured scan establishes no successful supported patch result | **Can safely prove not strong in the current model** | `strong` currently requires qualifying structured patch overlap. This is a full target-relevance scan, not a header discriminator. |
| Complete, stable scan establishes every supported successful patch path is safely normalized and disjoint from every target/blame/rename alias | **Can safely prove not strong** | Direct overlap is path-gated. Any unknown cwd/path, truncation, corruption, compaction materiality, or unsupported relevant event removes this proof. |
| Complete scan finds a target-related successful patch result but no recovered payload, one distinctive line, or a distant hunk | **Ranking only** | It can be plausible/weak; absence of a direct anchor must not be over-read when payload or hunk coverage is incomplete. |

The last three rows point to the useful optimization: scan each transcript once
for identity, coverage, cwd state, target-relevant patch facts, and a bounded
non-reversible relevance summary. A session that is *proved* unable to become
strong need not receive the more expensive evidence projection and Git path
resolution. A session without this proof remains eligible and its omission
continues to block uniqueness.

## Controlled consented real-session corpus

### Smallest safe corpus

Create a new private local Git repository solely for validation, outside this
project and outside any product checkout. It contains only deliberately
invented, non-sensitive text fixtures. Use a freshly created dedicated local
Codex home and an isolated OS account or disposable container profile. Disable
access to personal homes and credentials; permit no network, secret mounts, or
external repository remotes. Record the exact Codex version and the effective
`CODEX_HOME` used for each run.

Consent must be explicit from every human whose session is retained. The corpus
protocol should say that the rollout files are read locally only for Whyline
validation, never committed, uploaded, or pasted into reports, and can be
destroyed after the redacted fixtures and aggregate validation results are
approved. The corpus registry should contain opaque run labels, scenario,
Codex version, repository fixture version, and consent/retention-expiry state;
it must not contain prompts, paths, session IDs, transcript filenames, or raw
patches.

Use one short session per scenario and exact, distinctive invented lines. Ask
Codex to use the actual structured `apply_patch` tool, then have the human make
only the scenario's documented Git/history action. Capture the rollout before
and after the scenario with a private read-only copy or filesystem snapshot.
Do not hand-author JSONL as the primary proof.

| Run | Controlled action | Expected final correlation |
| --- | --- | --- |
| P1 | One session applies a two-distinctive-line patch; human commits exactly that result. | `matched` |
| P2a + P2b | Two separate qualifying sessions each apply a recoverable, target-hunk-overlapping change that survives one final commit. | `ambiguous` |
| P3 | Patch then amend or rebase to a new commit ID, retaining the distinctive target hunk. | Individually strong; `matched` if coverage is complete and unique. |
| P4 | Patch, then human changes one or both target lines before commit. | `none` or plausible only; never a sole authorship claim. |
| P5 | Patch in a linked worktree, then remove its worktree directory while preserving the Git prunable-worktree entry. | Historical linked-worktree eligibility; outcome driven by actual overlap. |
| P6 | Patch in an ordinary disposable worktree, delete it without a retained safe Git mapping, then test the documented historical-anchor conjunction. | No fabricated identity; either anchored evidence or a material unresolved limitation. |

P2 must be genuinely qualifying, not merely two sessions mentioning the same
file. The final hunk needs two distinctive recovered lines from each session,
with repository compatibility and no active divergence, so that the ambiguity
rule itself—not the cap or a limitation—is exercised.

### Isolation, retention, and redaction

Keep the original rollout corpus in a permission-restricted directory excluded
from Git and backup/sync tooling where feasible. Retain it only until the
version-pinned validation report and derived fixtures are accepted, then delete
the original and record deletion at aggregate level. If longer retention is
required, renew consent and encrypt storage under an owner-controlled key.

After observing each original rollout, generate the synthetic fixture from the
observed envelope/record relationships and normalized evidence behavior. Strip
or replace session IDs, timestamps, cwd, repository URLs, prompts, reasoning,
commands, tool output, and raw source/patch content. Preserve only invented
fixture text where a parser test genuinely needs it; correlation fixtures should
prefer the resulting non-reversible fingerprints and typed diagnostics. Link a
fixture to a private corpus run label only in the private registry, never in the
repository.

## Summary/discovery optimization options

1. **Invocation-local metrics and cache (recommended first).** Time discovery,
   summary scan, repository/Git classification, relevance scan, full evidence,
   projection, and renderer separately. Count files and bytes only. Cache a
   parsed summary/relevance result by `(device, inode, size, mtime)` within one
   invocation so the same selected file is not reparsed for both summary and
   extraction. No disk index, raw transcript persistence, or cross-invocation
   state.

2. **Combine summary and target-relevance scanning (recommended).** During the
   required complete summary stream, parse only supported structural records
   needed for cwd state, session metadata, final timestamp, diagnostics, and
   successful patch result/change headers. Derive bounded hashes/facts only for
   target aliases when a cwd is safely resolved. This does not reduce the bytes
   scanned, but can shrink post-scan Git projection and avoid reparsing sessions
   that are proven unable to be strong. It also removes duplicate reads for the
   selected candidates by retaining only privacy-safe normalized state.

3. **Bounded head/tail reads (conditional, not sufficient alone).** A head read
   may obtain initial session metadata; a reverse tail read may obtain the last
   complete timestamp. Neither sees arbitrary cwd transitions, compaction,
   rollback/abort, unknown structure, or earlier/later patch relevance. They
   may be a ranking hint but cannot make a candidate safely invisible.

4. **Targeted structured scans after cheap metadata (conditional).** Scan all
   files for only envelope type and known patch/cwd records, then fully parse
   only potentially relevant files. This may improve CPU/JSON work, but must
   still consume the whole file unless the source supplies a trusted record
   index. The scanner must treat unrecognized/oversized/corrupt records as
   coverage loss, not negative evidence.

5. **Persistent index (defer).** An index could reduce repeated 392 MiB scans,
   but carries transcript-derived metadata, invalidation, deletion, relocation,
   schema, and privacy obligations. The current one-invocation measurements do
   not prove an on-demand relevance scan cannot meet the agreed interactive
   target, so no index is justified yet.

## Active transcript snapshot semantics

The current `changed-during-read` diagnostic is correctly material. It compares
file identity, size, and mtime before and after a stream read. Suppressing it
would make an unbounded live transcript look complete even though a later
record could supply a competing strong patch or invalidate earlier evidence.

Append-only growth can be safe **only under an explicit new result semantic**:
“coverage is complete for the discovered Codex-history snapshot as of invocation
start,” not “complete current history.” That requires all of the following:

- a frozen discovery membership set as of the start boundary;
- for every member, an immutable byte prefix/extent fixed at that boundary;
- verified append-only behavior for the rollout format and no rewrite/rotation
  of that prefix; and
- a defined policy that records or files created after the boundary do not
  retroactively affect a result stated as-of that boundary.

A simple initial `stat.size` followed by reading only that many bytes addresses
only one file's prefix. It does not atomically freeze recursive directory
membership, detect a session file created between directory traversal steps,
or prove that the observed writer never rewrites a prefix. A final rescan can
detect many races but is not an atomic filesystem snapshot and cannot prove an
intermediate create/delete did not occur. The observed JSONL format is not a
stable public interface, so its append-only behavior is not currently a
sufficient contract.

Therefore do not implement snapshot acceptance yet. A future design may use a
source-provided immutable manifest/snapshot API, an OS/filesystem snapshot, or
a documented writer lock/epoch. Without one, retain fail-closed
`changed-during-read`. If Sol accepts as-of-start semantics, the coverage type,
renderer wording, tests, and result reproducibility contract must change
explicitly; this is not a diagnostic-only optimization.

## Recommended hardening architecture

Keep staged on-demand analysis, but split the adapter's first pass into a
privacy-minimized **summary-and-relevance** result:

```text
discover immutable-or-fail-closed refs
  -> one streaming summary + relevance scan per ref
  -> safe repository classification and target-anchor resolution
  -> proven-not-strong exclusion / otherwise eligible ranking
  -> bounded rich evidence projection only for remaining candidates
  -> existing pure scoring and complete-coverage selection
```

The first pass returns typed coverage, cwd transitions, identity/timestamps,
summary commit context, and target-relevant structured patch facts/hashes only.
It must never retain prompts, commands, raw patch text, raw paths for rendering,
or transcript source locations. It can only prune after a proof described in
the discriminator table; otherwise it preserves the candidate or emits a
material limitation.

Expected latency effect: the current 8.9 s profile cannot become interactive
merely by avoiding the 32 rich parses—the parsers themselves account for only
about 0.36 s aggregate, while 4.24 s is summary scanning and about 8.81 s of
overlapping classification Git spans occur across 966 calls. Combining passes
should remove duplicated selected-file reads and much of rich per-session Git
projection, plausibly reducing several hundred milliseconds to low seconds.
Reaching a sub-two-second goal on ~392 MiB is unproven without reducing scan
bytes, Git calls, or adding a trusted snapshot/cache mechanism. Measure the
new design before setting a latency commitment.

## Risks and required Sol decisions

**Correctness risks:** a relevance scan can accidentally treat a missing,
unknown, truncated, or cwd-ambiguous record as proof of no patch; stale SHAs
can be mistaken for negative evidence; and parallel Git classification can
oversubscribe the machine. Preserve typed “cannot prove” paths and bound
concurrency while measuring wall latency.

**Privacy risks:** any cached/indexed transcript facts become retained sensitive
metadata; diagnostic text or metrics labels can expose paths; and a corpus can
become a de facto personal transcript archive. Keep data in memory for one
invocation, use aggregate metrics, fixed renderer strings, consent expiry, and
redacted derived fixtures only.

Sol-level architecture decisions required before implementation:

1. Is an explicit “as of invocation-start Codex snapshot” claim acceptable, or
   must live history remain fail-closed until an atomic source snapshot exists?
2. What latency budget is binding for approximately 400 MiB retained history,
   and may bounded worker concurrency replace the current unbounded
   `Promise.all` fan-out?
3. Is a complete structured target-relevance scan allowed to be the
   pre-extraction proof boundary, with no persistent index, or is a
   privacy-reviewed cache/index required only after measuring that design?
4. What retention owner and expiry policy authorizes the consented corpus, and
   may a private non-repository registry link runs to derived fixtures?
5. Does the first milestone validate both deleted-unmapped and deleted-prunable
   linked-worktree cases, or is one deferred after P5 establishes linked mapping?

## Smallest next implementation milestone

Implement no confidence or cap changes. Add only:

1. a private, consented P1/P2 corpus runbook plus a redacted derived fixture
   procedure; execute P1 and P2 to demonstrate one real `matched` and one real
   `ambiguous` result;
2. invocation-local aggregate timing/counter seams and tests that verify they
   contain no transcript-derived strings; and
3. one-pass, fail-closed summary-and-target-relevance scanning with only the
   safe “proved not strong” pruning rules, retaining all uncertain candidates
   as material coverage.

This preserves the false-positive invariant and starts removing duplicate work.
It should be followed by a fresh representative latency profile before any
snapshot semantic change, cap reconsideration, or persistent index proposal.
