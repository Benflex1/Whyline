# Conservative Git ↔ Codex Correlation Design

**Status:** approved design
**Date:** 2026-08-08
**Branch:** `feat/conservative-correlation`

## Goal

Connect the existing Git provenance report and Codex history adapter for committed
locations while preferring a Git-only answer over an unsupported causal claim.
Whyline may select a Codex session only when exactly one strongly supported
candidate remains and the inspected candidate set has enough coverage to assert
that uniqueness.

This slice does not change the meaning of Git blame or the normalized Codex
evidence. Git remains authoritative for current textual attribution. The Codex
adapter remains authoritative for observed transcript facts. Correlation derives
only a bounded relationship between those facts.

## Scope and non-goals

The slice supports committed queries through the existing command:

```text
whyline <file>:<line>
```

It adds deterministic, local-only correlation for the existing Codex adapter and
minimal combined terminal reporting. It does not add semantic ancestry, AST or
embedding matching, prompts or reasoning analysis, generic file-read inference,
shell parsing, shell-output success inference, uncommitted-line attribution,
remote access, persistent indexes, SQLite, additional agent providers, a web or
IDE surface, or a daemon.

Uncommitted and untracked queried lines return before Codex discovery. Their Git
result remains successful and receives no Codex attribution.

## Architectural boundary

The implementation has three boundaries:

1. Git provenance produces a narrow target containing only the repository and
   change evidence needed for correlation.
2. The agent-history source discovers summaries and extracts normalized evidence
   through its existing staged contract. Codex record names and JSON shapes do
   not leave the adapter.
3. The pure `src/correlation/` domain layer evaluates compatibility, signals,
   contradictions, confidence bands, coverage, and final selection. It does
   not access the filesystem, invoke Git, read transcripts, or render text.

Staged runtime flow:

```text
committed Git provenance
  ↓
narrow CorrelationTarget
  ↓
summary discovery for all refs
  ↓
repository compatibility + summary-level commit resolution
  ↓
cheap deterministic ranking and bounded candidate set
  ↓
full evidence extraction for bounded eligible refs only
  ↓
read-only resolution of evidence commit abbreviations
  ↓
pure correlation
  ↓
combined normalized report and sanitized renderer
```

The default full-evidence cap is 32 candidates. It is an internal bounded-work
constant and a test seam, not user configuration and not a persistent index.
Every eligible ref beyond the cap is counted as omitted; it is never silently
treated as unrelated.

## Domain types

The exact TypeScript declaration may be split by responsibility, but its
semantics are fixed here.

```ts
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

type CorrelationRepositoryMatch =
  | "current-worktree"
  | "linked-worktree"
  | "same-common-directory"
  | "historical-commit-anchored"
  | "unknown"
  | "incompatible";

interface CorrelationTarget {
  readonly repository: {
    readonly worktreeRoot: string;
    readonly commonGitDir: string;
    readonly objectFormat: string;
    readonly worktrees: readonly {
      readonly path: string;
      readonly commonGitDir: string;
    }[];
  };
  readonly targetPath: string;
  readonly blamedPath: string | null;
  readonly commit: {
    readonly id: string;
    readonly authoredAt: string;
    readonly committedAt: string;
  };
  readonly selectedParentId: string | null;
  readonly changedPaths: readonly {
    readonly oldPath: string | null;
    readonly newPath: string | null;
  }[];
  readonly relevantHunks: readonly CorrelationHunk[];
}

/** Optional extraction hint; not the rich Git-derived CorrelationTarget. */
interface AgentEvidenceTarget {
  readonly repositoryPath?: string;
  readonly line?: number;
  readonly worktreeRoot?: string;
}

interface CorrelationHunk {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly targetLineKind: "added" | "context" | null;
  readonly addedLineFingerprints: readonly string[];
  readonly deletedLineFingerprints: readonly string[];
  readonly distinctiveAddedLineFingerprints: readonly string[];
  readonly distinctiveDeletedLineFingerprints: readonly string[];
  readonly truncated: boolean;
}

interface CorrelationSignal {
  readonly kind: CorrelationSignalKind;
  readonly weight: number;
  readonly basis: "fact" | "derived" | "inferred";
  readonly evidenceIds: readonly string[];
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
  readonly kind: CorrelationLimitationKind;
  readonly material: boolean;
  readonly count?: number;
}

interface CorrelationCoverage {
  readonly status: "complete" | "limited" | "unavailable";
  readonly discoveredRefs: number;
  readonly summaryEligibleRefs: number;
  readonly fullyExtractedRefs: number;
  readonly omittedEligibleRefs: number;
  readonly limitations: readonly CorrelationLimitation[];
}

type AgentHistoryAvailability = "available" | "limited" | "unavailable";

interface AgentHistoryDiscoveryResult {
  readonly availability: AgentHistoryAvailability;
  readonly refs: readonly AgentSessionRef[];
  readonly diagnostics: readonly AgentDiagnostic[];
}

type AgentCommitReferenceKind = "session-head" | "produced-commit" | "unknown";

interface AgentEvidenceCommitReference {
  readonly commitReferenceKind: AgentCommitReferenceKind;
  readonly commitIds: readonly string[];
}

interface AgentPatchHunkRange {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

type AgentPatchMatchSide = "added" | "deleted" | "content";

interface AgentPatchChange {
  readonly path: string;
  readonly changeType: "update" | "add" | "delete" | "unknown";
  readonly payloadKind: "unified-diff" | "content";
  readonly payloadRecovered: boolean;
  readonly payloadFingerprint: string;
  readonly payloadTruncated: boolean;
  /** Retained for compatibility; correlation uses the explicit side fields. */
  readonly addedLineFingerprints: readonly string[];
  /** Lines compared against the Git hunk side selected by matchSide. */
  readonly matchLineFingerprints: readonly string[];
  /** Subset sufficient to prove whether two distinctive payload lines exist. */
  readonly distinctiveLineFingerprints: readonly string[];
  readonly matchSide: AgentPatchMatchSide;
  readonly hunkRanges: readonly AgentPatchHunkRange[];
  readonly lineCount: number;
  readonly movedFrom?: string;
}

interface CorrelationCandidate {
  readonly session: AgentSessionSummary;
  readonly eligible: boolean;
  readonly repositoryMatch: CorrelationRepositoryMatch;
  readonly score: number;
  readonly signals: readonly CorrelationSignal[];
  readonly contradictions: readonly CorrelationSignal[];
  readonly band: "strong" | "plausible" | "weak";
  readonly coverage: "complete" | "limited";
  readonly coverageLimitations: readonly CorrelationLimitation[];
}

interface CorrelationResult {
  readonly status: "matched" | "ambiguous" | "none" | "unavailable";
  readonly selected?: CorrelationCandidate;
  readonly alternatives: readonly CorrelationCandidate[];
  readonly coverage: CorrelationCoverage;
}
```

Signals carry closed kinds and evidence identifiers, not renderer prose. The
renderer derives bounded explanations from the signal, contradiction,
limitation, and result-status kinds through a fixed presentation map; no raw
domain key, transcript text, path, or arbitrary explanation string is accepted
as a user-visible explanation.

`AgentSessionSummary`, `AgentEvidenceBundle`, and `AgentEvidence` above are the
existing agent-neutral contracts. No Codex event or parser type is introduced in
these correlation types.

For the current adapter, `session_meta.payload.git.commit_hash` is normalized as
`commitReferenceKind: "session-head"` in `AgentEvidenceCommitReference` data,
both summary context and its `git-revision-reference` evidence. The observed
value is repository/HEAD context, not empirically verified evidence that the
session produced or committed that object. It may support cheap ranking,
summary anchoring, and the historical-commit conjunction, but it is not an
independent direct change anchor. `produced-commit` is reserved for a future
empirically verified evidence form. A patch overlap with completely unknown
repository identity cannot become a selected match by itself.

## Repository compatibility and eligibility

Compatibility is resolved before scoring. The scorer receives a classification,
not filesystem or Git access.

### Positive compatibility

- A session cwd that canonically falls inside the current worktree is
  `current-worktree` and contributes `+5`.
- A session cwd that falls inside another Git worktree with the current common
  Git directory is `linked-worktree` and contributes `+4`.
- A historical cwd that resolves through read-only Git inspection to the current
  common Git directory is `same-common-directory` and contributes `+4`.
- A listed/prunable worktree path remains a valid linked-worktree match when the
  current Git worktree mapping still establishes that identity.

### Unknown and incompatible context

- A missing, deleted, relocated, or otherwise unresolvable cwd contributes no
  positive repository signal. It is not equivalent to a known mismatch.
- A cwd that resolves to another known Git common directory is `incompatible`
  and is excluded before any score is calculated. No score can repair this
  exclusion.
- A session with no positive repository context may enter bounded extraction when
  its summary contains a safely resolved session-head target reference or another
  future normalized repository/commit anchor. If no safe summary anchor exists,
  it may be omitted from full extraction, but the omission is recorded as the
  material `unresolved-repository-candidate` coverage limitation.
- A target commit reference with unknown repository context remains weak unless
  qualifying structured patch overlap supplies the second, content-level anchor.

Repository basenames, relative filenames, transcript filenames, branch names,
and stale SHA values do not establish repository identity. Transcript repository
URLs are never retained or rendered.

A summary without a structured session ID is unsupported and is not a candidate.
Subagents remain separate candidates; parent/fork fields are contextual only.

### Commit-reference handling

Reference comparison uses the current repository's actual object format and
read-only Git resolution. A full object ID is compared directly; an abbreviated
ID contributes a reference signal only when the current repository resolves it
to exactly one object. An ambiguous abbreviation contributes no match signal.
No remote, fetch, or transcript command execution is allowed. A stale or
unresolvable `session-head` ID after a rebase or amend is supporting historical
context and does not exclude a candidate whose current structured patch overlaps
the target hunk. It is never a produced-commit claim.

The current adapter emits only `session-head` references from session metadata.
Only a future normalized `produced-commit` reference whose producer semantics
have been empirically verified may be treated as a direct commit anchor.

## Signals and contradictions

The scorer uses an additive score only for deterministic ordering. It is not a
probability and is never rendered.

| Signal | Weight | Eligibility/use |
| --- | ---: | --- |
| `session-head-target-reference` | +2 | Uniquely resolved observed session HEAD context; useful for ranking/anchoring, never a current-v0 direct change anchor. |
| `produced-target-commit-reference` | +10 | Reserved for a future empirically verified commit-producing reference kind; not emitted by the current adapter. |
| `structured-patch-overlap` | +8 | At least two distinctive matching fingerprints from a successful recovered supported payload. |
| `exact-current-worktree` | +5 | Canonical cwd mapping to the current worktree. |
| `linked-worktree-common-directory` | +4 | Canonical cwd mapping to a linked/current common Git directory. |
| `structured-patch-target-path` | +4 | Successful recovered structured patch change on target, blamed, or rename-related path. |
| `changed-path-overlap` | +1 to +3 | Supported structured patch path overlaps a commit changed path; exact target/rename paths receive the larger value. |
| `structured-patch-attempt-target-path` | +1 | Structured patch attempt names the target path but has no recovered successful payload. |
| `temporal-proximity` | +1 or +2 | Minimum distance from the session observed interval to authored/committed time is within seven days or 24 hours. |
| `structured-content-divergence` | −5 | Operation- and hunk-aware competing content remains after chronological supersession. |

There are no command, test, build, lint, prompt, reasoning, generic read, raw
output, or shell-success signals. The adapter's command records remain attempts
only and are not parsed for paths or outcomes.

A stale nonmatching `session-head` reference is represented, when useful, by the
zero-weight `historical-commit-reference` signal. It is supporting historical
context, not a mismatch contradiction. Known repository mismatch is represented
as an eligibility exclusion, not as `−10`.

## Confidence bands

### Strong

A candidate is individually `strong` when:

- it is eligible;
- it has credible current/linked/common-directory repository compatibility, or
  the historical-commit-anchored conjunction described below;
- it has no active structured-content contradiction; and
- it has qualifying structured patch overlap in the current v0 evidence model.
  A future `produced-commit` reference may provide an additional direct anchor
  only after its evidence semantics are empirically verified.

For an unknown/deleted cwd, a uniquely resolved `session-head` target reference
plus qualifying structured patch overlap is required. Neither the observed
session HEAD reference nor patch overlap alone is enough.

### Plausible

A candidate is `plausible` when it is eligible, has credible repository
compatibility, has at least two independent supporting signals, and at least one
signal is a successful structured patch target-path signal or a changed-path
overlap. A patch attempt without a recovered successful payload is weak support
only and cannot satisfy this requirement. Repository context plus time,
repository context plus a filename/path mention, or time plus a filename/path
mention cannot reach `plausible`.

### Weak

All other eligible candidates are `weak`. Weak candidates are not surfaced as
likely sources.

Candidate band and coverage are independent. A candidate can be individually
`strong` while its transcript or candidate-set coverage prevents a final
`matched` result.

## Structured patch ↔ Git hunk matching

Direct overlap is available only for successful recovered `patch-result` changes
from supported structured patch variants. A patch attempt or failed patch result
can supply only a weak path signal. Generic commands, arbitrary output, assistant
text, and prompt text never produce patch evidence.

### Fingerprints

Both sides normalize CRLF and CR to LF and then hash each line with the existing
non-reversible SHA-256 digest convention. The matcher does not trim, collapse
whitespace, normalize identifiers, normalize literals, or otherwise rewrite code
before hashing. The raw Git line is used only transiently to decide whether its
fingerprint is distinctive; source text is not retained in the correlation
result.

A distinctive line is nonempty, at least four characters after a temporary
classification trim, not punctuation-only, not a lone identifier, and not
boilerplate such as `return value;`. The adapter retains both the
operation-appropriate match fingerprints and the subset of fingerprints that
passed this distinctiveness classification. At least two distinctive matching
line fingerprints are required for a direct patch anchor. One matching line can
still be retained as non-strong supporting evidence, but cannot produce
`strong`.

### Operation-aware sides

- `update` with `unified-diff`: compare Codex added-line fingerprints to Git
  added-line fingerprints. The normalized change uses `matchSide: "added"`,
  `matchLineFingerprints` for the added lines, and `hunkRanges` parsed from the
  unified-diff headers.
- `add` with `content`: compare Codex post-image line fingerprints to Git added
  lines. The normalized change uses `matchSide: "content"`, all bounded content
  line fingerprints, and no unified-diff hunk ranges.
- `delete` with `content`: compare Codex deleted-content fingerprints to Git
  deleted lines. The normalized change uses `matchSide: "deleted"`, all bounded
  deleted-content line fingerprints, and no unified-diff hunk ranges.
- Other combinations produce no direct overlap.

The path must match the current target, blamed historical path, or a
rename-related old/new path. Truncated payloads never establish a direct anchor.
The normalized adapter change carries `matchLineFingerprints`,
`distinctiveLineFingerprints`, `matchSide`, and bounded numeric unified-diff
`hunkRanges`; these fields contain no source text. The existing
`addedLineFingerprints` field remains for compatibility, but correlation uses the
explicit side fields.

## Operation- and chronology-aware divergence

Content divergence is not inferred from any unrelated same-file patch. For each
target-related path, successful recovered structured changes are ordered by
transcript record number (the stable local observation order).

- A competing change must use a supported operation, contain at least two
  distinctive payload lines, target the relevant hunk range, and have no direct
  overlap with any relevant Git hunk.
- Content-only `add` and `delete` payloads have no source hunk coordinates. They
  may establish a direct match through two distinctive deleted/content lines,
  but non-overlap from such a payload alone cannot establish divergence. A
  divergence for those forms requires future normalized coordinates or another
  direct hunk-locality fact.
- An earlier divergence is suppressed when a later direct matching change on the
  same target-related path supersedes it.
- A later competing divergence remains active after an earlier matching change,
  unless a still-later direct match supersedes it.
- A successful patch in a different hunk of the same file is not a divergence.
- If any relevant Git hunk is truncated, absence of overlap cannot establish
  divergence because retained Git evidence may be incomplete.
- A lone competing divergence produces the `structured-content-divergence`
  contradiction and blocks `strong`, while leaving weaker relation signals
  available.

The scorer preserves both positive and contradiction signals. It does not erase
an earlier patch record or treat the final score as authorship probability.

## Candidate staging and coverage

The provenance coordinator reads summary metadata for every discovered reference,
then performs cheap repository classification and summary-level commit reference
resolution. It ranks eligible references by:

1. resolved session-head or future produced-commit context anchor;
2. current-worktree or linked-worktree compatibility;
3. bounded temporal proximity;
4. opaque source-path lexical order as a deterministic tie-breaker.

It extracts full evidence only for the first 32 candidates. A candidate omitted
because of the cap is not treated as unrelated. A valid session with unresolved
repository context and no safe summary anchor may be omitted, but produces the
material unresolved-repository coverage limitation.

The domain result reports coverage independently:

- `complete`: discovery finished, no material discovery limitations exist, no
  eligible candidate was omitted, every usable eligible summary was fully
  extracted, no material candidate evidence limitation remains, and no relevant
  Git hunk is truncated;
- `limited`: one or more eligible refs were omitted or their evidence could hide
  a relevant competing change or candidate;
- `unavailable`: no readable/usable history source could be inspected.

An empty readable store is not unavailable. The discovery contract must expose
source availability independently from the ref count, so these cases remain
distinct:

- effective Codex home unavailable or unreadable: source `unavailable`, final
  result `unavailable`;
- readable Codex home and readable stores with zero refs: source `available`,
  final result `none` with `empty-readable-store` limitation;
- readable home with one or more partially unreadable stores: source `limited`,
  limited coverage, and no result may assert uniqueness;
- a missing optional archived store does not make the readable home unavailable.

Coverage materiality is semantic rather than a diagnostic count. Unknown benign
records, invalid timestamps, unlinked command results, and malformed command
arguments can remain informational when a later complete direct patch establishes
the relevant evidence. A diagnostic is material when it can hide or invalidate
the evidence needed for correlation or uniqueness, including changed-during-read,
partial/corrupt relevant transcript data, truncated direct payloads, unsupported
potentially eligible summaries, omitted eligible candidates, unresolved
repository candidates, `truncated-git-hunk`, or compaction/rollback/abort records
that occur after the last relevant evidence or before any reliable direct
evidence. A truncated relevant Git hunk is always material for final selection.
It may leave an observed candidate individually `strong`, but it prevents
`matched`; it never creates divergence merely from missing overlap.

## Final result semantics

Selection is deliberately stricter than candidate scoring:

1. Exactly one `strong` candidate plus sufficient non-material coverage yields
   `matched` and selects it. Plausible and weak alternatives remain attached.
2. Two or more `strong` candidates yields `ambiguous`, regardless of score or
   time. No session is selected.
3. One `strong` candidate with material candidate-set or evidence coverage yields
   `none`, no selected session, and retains the candidate as possible evidence.
4. Zero `strong` candidates yields `none`. A lone plausible candidate remains in
   `alternatives` and is rendered as possible only; weak candidates normally are
   not surfaced.
5. An unavailable or unreadable Codex source yields `unavailable`; a readable
   source with zero refs yields `none`.

The selected-session wording is always “Likely related Codex session.” It never
says “Written by Codex,” “authored by Codex,” or an equivalent sole-authorship
claim.

## Agent-history contract widening

Only changes demonstrated necessary by the integration are permitted:

- Add an optional agent-neutral discovery result matching
  `AgentHistoryDiscoveryResult`, exposing `refs`, discovery diagnostics, and an
  explicit `available`/`limited`/`unavailable` source state. The existing async
  `discover` iteration remains supported. A readable source with zero refs is
  `available`, not `unavailable`.
- Rename the existing optional extraction hint from `CorrelationTarget` to
  `AgentEvidenceTarget`. The rich Git-derived `CorrelationTarget` is owned by
  `src/correlation/` and is never the adapter's parser contract.
- Add the minimum privacy-safe normalized patch fields to `AgentPatchChange`:
  `matchLineFingerprints`, `distinctiveLineFingerprints`, `matchSide`, and
  bounded numeric `hunkRanges`. Preserve `addedLineFingerprints` for contract
  compatibility, but define it as a legacy alias for update/add payloads; it is
  empty for delete/content changes. No raw source is retained.
- Mark current `git-revision-reference` evidence and
  `transcriptGit.commitHash` as `commitReferenceKind: "session-head"`. The
  current adapter emits no `produced-commit` reference.
- Preserve the existing `historyRoot` test seam and add a narrow analysis-level
  Codex-home/source injection seam. No general configuration framework is added.

No Codex parser schema, transcript filename, repository URL, prompt, command,
tool output, or raw patch payload is exposed to correlation or rendering.

## Combined report and privacy

`WhylineReport` gains an optional normalized correlation result for committed
locations. Existing Git sections remain stable. The new renderer section is
bounded and typed:

- matched: safe short session ID and positive signal explanations;
- ambiguous: collision-safe short IDs for all strong candidates and no selection;
- plausible-only: safe short ID plus explicit insufficient-evidence wording;
- none: no reliable match wording;
- unavailable: local Codex history unavailable wording.

Short IDs are derived only from structured `sessionId`. The renderer chooses a
prefix, then extends it as needed so every displayed candidate in that report
has a unique displayed ID. It never falls back to a transcript filename or
source path. Session IDs, explanations, and limitations are sanitized and
bounded. Absolute transcript paths, repository URLs, prompts, reasoning, raw
commands, raw output, and source-code snippets from transcripts are never
rendered. Correlation scores are never rendered as percentages or confidence
values.

## Test matrix

### Pure correlation decisions

Table-driven tests must cover:

1. current repository plus exact observed session-head SHA but no patch → not
   strong;
2. current repository plus two-line structured overlap → strong;
3. stale/rebased session-head SHA plus current distinctive patch overlap → strong;
4. abbreviated target reference uniquely resolving versus ambiguous → only the
   unique reference contributes;
5. exact session-head SHA with unknown repository context → not selected by SHA
   alone;
6. unknown/deleted cwd plus exact session-head SHA plus matching patch →
   historical strong;
7. unknown/deleted cwd plus patch only → not strong;
8. same filename/close timestamp only → weak;
9. same repository/close timestamp only → weak;
10. repository plus changed-path overlap → plausible at most;
11. test/build/lint or command activity → no authorship increase;
12. known different common Git directory → excluded;
13. same basename in an unrelated repository → excluded;
14. same-path patch attempt without recovered success → weak support only;
15. update, add, and delete operation overlap with side-appropriate fingerprints;
16. boilerplate-only overlap → not strong;
17. earlier divergent then later matching patch → no active divergence;
18. matching then later competing divergence → contradiction remains;
19. unrelated same-file different hunk → no divergence;
20. only divergent patch → downgraded/no strong;
21. two strong candidates → ambiguous;
22. one strong plus one plausible → strong selected when coverage is complete;
23. two plausible candidates → none;
24. root and subagent both strong → ambiguous;
25. squash-shaped two-session overlap → ambiguous;
26. human-edited related content → plausible or none, never sole authorship;
27. compaction before a superseding direct patch → informational when safe;
28. compaction or corruption after relevant evidence → material;
29. changed-during-read → material;
30. truncated relevant Git hunk → no matched and no inferred divergence;
31. omitted eligible candidate or unresolved repository candidate → no matched;
32. empty readable store → none, not unavailable;
33. unreadable/unavailable source → unavailable.

### Adapter and staged-flow tests

- structured patch hunk ranges are extracted without retaining source text;
- discovery reports available-empty, available-limited, and unavailable stores
  distinctly;
- summary parsing happens for all refs while full evidence extraction is bounded
  at 32;
- abbreviated commit resolution uses only read-only argv Git calls and no remote;
- subagent sessions remain separate candidates;
- adapter diagnostics map to typed informational/material coverage without raw
  transcript detail.

### Synthetic end-to-end tests

Temporary Git repositories and temporary synthetic Codex homes must prove:

1. matching structured patch → `matched`;
2. unrelated session → `none`;
3. two matching sessions → `ambiguous`;
4. plausible-only evidence → `none` with possible-session rendering;
5. no Codex history → successful Git-only report;
6. uncommitted target → no Codex discovery/attribution;
7. rebased equivalent patch → content-based correlation survives the stale SHA;
8. transcript prompts/output/raw patch material never appears in the report;
9. collision-safe session ID shortening distinguishes displayed candidates;
10. no automated test reads the real `~/.codex`.

## Verification constraints

The implementation must preserve these operational invariants:

- all Git operations are read-only and use the existing argv-based process
  boundary;
- no transcript command is executed or shell-parsed;
- no network or remote repository access occurs;
- Git-only analysis remains exit code `0` when Codex is absent, empty, limited,
  or unavailable;
- uncommitted lines never trigger Codex attribution;
- time-only evidence can never produce `matched`;
- plausible-only evidence can never produce a selected session;
- two strong candidates always remain ambiguous;
- only supported structured patch variants can produce hunk overlap;
- scores remain internal ordering values and are never presented as probabilities.

## Remaining v0 limitations

Deleted or relocated worktrees without a safe repository/commit anchor may be
omitted from full extraction and will reduce coverage rather than produce a
causal answer. Transcript formats outside the empirically supported Codex
envelope remain diagnostic-only. Correlation cannot determine semantic ancestry,
split authorship inside a squash commit, or whether a human made the final edit.
