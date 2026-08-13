# Conservative Worktree-Change Correlation Design

**Status:** approved milestone; frozen for implementation planning
**Date:** 2026-08-13
**Baseline:** `de1454b05cc02db2ed54537d8780df33b1d93377`

## Goal

Remove Whyline's current Codex-analysis hard stop for an uncommitted queried
location. When the current queried line is on the current side of a complete,
bounded `HEAD -> working tree` change, Whyline may correlate that change with
retained successful structured Codex patch evidence.

The result remains deliberately narrower than authorship or origin:

```text
current queried location
    |
    +-- committed relative to HEAD
    |      `-- existing committed provenance pipeline unchanged
    |
    `-- current-side worktree change
           +-- textual state: uncommitted
           +-- Git ancestry: not run
           `-- independently typed worktree correlation target
                    |
                    `-- matched | ambiguous | none | unavailable
```

A worktree change is not a commit. The feature does not fabricate a commit,
blame attribution, parent, Git ancestry, historical origin, authorship, or
semantic cause. The allowed positive claim is only that one retained Codex
session is **likely related** because its successful structured patch has a
complete, exact, query-local overlap with the final verified worktree change.

## Governing invariants

The following rules are frozen:

1. `HEAD -> working-tree content` is the only worktree comparison for this
   milestone. The index is neither a provenance layer nor a correlation target.
2. The final current file content is authoritative. Staged, unstaged, and
   partially staged states do not create separate attribution decisions.
3. An unchanged queried line in a dirty file continues through the existing
   committed pipeline. File-level dirtiness is never query-local evidence.
4. Uncommitted lines receive no Git ancestry. Worktree correlation is a
   separate evidence domain, not a new ancestry result.
5. Worktree evidence is line-specific. Whole-file add evidence does not promote
   every current line in an untracked or added file.
6. Only successful supported structured patch evidence can make a worktree
   candidate strong.
7. Strong worktree evidence must resolve to the exact current worktree. A
   linked worktree, shared common Git directory, deleted historical cwd, or
   candidate-level repository association is insufficient.
8. The committed correlation decision table, thresholds, weights, target
   semantics, coverage rules, and rendering remain unchanged.
9. Exactly one strong candidate plus sufficient coverage is `matched`; two or
   more strong candidates are `ambiguous`; a lone plausible candidate remains
   `none` with an alternative; source unavailability remains `unavailable`.
10. No prompt, reasoning, command, output, test record, timestamp, or commit
    reference can establish strong worktree correlation.
11. All evidence is local, read-only, bounded, ephemeral, and privacy-minimized.
12. Expected missing or bounded evidence degrades explicitly. Repository,
    source, or target mutation during analysis remains an operational failure.

## Domain model

### Target distinction

The existing `CorrelationTarget` becomes the committed variant without a
semantic change. The correlation domain gains an explicit union:

```ts
interface CorrelationRepositoryIdentity {
  readonly worktreeRoot: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly objectFormat: string;
  readonly worktrees: readonly {
    readonly path: string;
    readonly commonGitDir: string;
  }[];
}

interface CommitCorrelationTarget {
  readonly kind: "commit";
  readonly repository: CorrelationRepositoryIdentity;
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

interface WorktreeCorrelationTarget {
  readonly kind: "worktree";
  readonly basis: "derived";
  readonly repository: CorrelationRepositoryIdentity;
  readonly baseCommitId: string;
  readonly targetPath: string;
  readonly changeKind: "modified" | "added";
  readonly staging: "staged" | "unstaged" | "partially-staged" | "untracked" | "unknown";
  readonly queriedSpans: readonly RangeLineSpan[];
  readonly relevantHunks: readonly WorktreeCorrelationHunk[];
  readonly targetSnapshot: WorktreeTargetSnapshot;
}

type ProvenanceCorrelationTarget =
  | CommitCorrelationTarget
  | WorktreeCorrelationTarget;
```

`staging` is bounded diagnostic metadata only. It cannot affect candidate
eligibility, strength, ambiguity, or wording beyond an optional details line.
If staging cannot be classified without ambiguity, it is `unknown`; the
`HEAD -> worktree` target remains valid if its own evidence is complete.

The existing committed target may gain the `kind: "commit"` discriminant and
the worktree-specific Git-directory fields needed for exact identity. Those are
mechanical additions. No committed signal or outcome changes.

### Worktree hunk and target snapshot

Worktree hunks are current-side proof material, not commit hunks:

```ts
interface WorktreeCorrelationHunk extends CorrelationHunk {
  readonly basis: "derived";
  readonly operation: "update" | "add";
  readonly queriedSpans: readonly RangeLineSpan[];
  readonly currentLineFingerprints: readonly string[];
  readonly currentDistinctiveLineFingerprints: readonly string[];
  /** Parallel to currentLineFingerprints; derived before source text is discarded. */
  readonly currentLineAlphanumericCounts: readonly number[];
  readonly complete: true;
}

interface WorktreeTargetSnapshot {
  readonly baseCommitId: string;
  readonly repositoryPath: string;
  readonly changeKind: WorktreeCorrelationTarget["changeKind"];
  readonly fileSnapshot: FileSnapshot;
  /** Digest of bounded path/change/hunk coordinates and fingerprints. */
  readonly evidenceDigest: string;
}
```

The target retains fingerprints and counts, not raw worktree diff text. All
fingerprints are invocation-local SHA-256 digests and are never persisted.

### Query-local overlap proof

`ready` target construction does not itself prove a Codex relationship. A pure
worktree overlap function compares one target hunk with one normalized patch
hunk and returns a candidate-specific result:

```ts
type WorktreeOverlapResult =
  | {
      readonly status: "exact";
      readonly basis: "derived";
      readonly comparison: "exact-line-fingerprints";
      readonly targetStartLine: number;
      readonly patchStartLine: number;
      readonly matchedLineCount: number;
      readonly distinctiveLineCount: number;
      readonly alphanumericCount: number;
      readonly coveredQuerySpans: readonly RangeLineSpan[];
    }
  | {
      readonly status: "insufficient";
      readonly reason:
        | "query-not-covered"
        | "insufficient-distinctive-material"
        | "ambiguous-exact-alignment"
        | "hunk-locality-mismatch"
        | "operation-mismatch"
        | "path-mismatch";
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "target-incomplete"
        | "patch-incomplete"
        | "fingerprint-coverage-incomplete";
    };
```

The proof aligns ordered exact fingerprints. It must identify exactly one
contiguous alignment that includes every line in the group's queried spans.
The aligned block expands only within the same current-side added run and the
same patch hunk, to at most 32 lines. It succeeds only with at least two unique
distinctive exact lines and at least 40 alphanumeric characters. Whitespace,
case, punctuation, and line order are not normalized.

A generic queried line may be covered only when it lies inside that unique,
strong exact aligned block. The neighboring distinctive lines support the
alignment; they do not promote another line outside the block. A repeated line
with two possible alignments is insufficient, never selected by position or
score.

### Normalized patch hunk evidence

Repository inspection found that `AgentPatchChange` currently retains hunk
ranges and flattened line fingerprints. That representation cannot prove which
matching lines belong to which patch hunk, and therefore cannot safely establish
query locality for multi-hunk updates or whole-file adds.

The normalized agent contract gains bounded, non-reversible per-hunk material:

```ts
interface AgentPatchHunkEvidence {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly matchSide: "added" | "content";
  readonly orderedLineFingerprints: readonly string[];
  readonly distinctiveLineFingerprints: readonly string[];
  readonly lineCount: number;
  readonly truncated: boolean;
}

interface AgentPatchChange {
  // Existing fields remain unchanged.
  readonly worktreeHunks?: readonly AgentPatchHunkEvidence[];
}
```

For an `update`, each supported unified-diff hunk has its own added-side
fingerprints and coordinates. For an `add`, one synthetic content hunk begins at
current line 1. The existing total 128-fingerprint bound is shared across these
hunks in source order; it is not multiplied per hunk. Omitted hunk lines set
`truncated: true`. Existing flattened fields remain authoritative for committed
correlation, which does not consume `worktreeHunks`.

This is an extension of the existing Codex normalization boundary, not a new
adapter or transcript format dependency.

## Worktree target construction outcomes

Target construction uses a small envelope separate from `CorrelationResult`:

```ts
type WorktreeTargetConstruction =
  | { readonly status: "ready"; readonly target: WorktreeCorrelationTarget }
  | {
      readonly status: "insufficient";
      readonly reason:
        | "query-not-current-side-change"
        | "insufficient-distinctive-material";
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "unmerged"
        | "unsupported-change-shape"
        | "missing-head-object"
        | "incomplete-diff";
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "work-bound";
      readonly reason: "file-too-large" | "hunk-too-large" | "group-limit";
      readonly limitations: readonly string[];
    };
```

This envelope does not add a correlation status:

- `insufficient` means complete local facts cannot meet the minimum exact proof
  floor, so Whyline does not claim that it searched agents and found none.
- `unavailable` means a safe target could not be constructed.
- `work-bound` means required work or material was intentionally omitted.
- `ready` permits Codex projection. Its eventual `CorrelationResult` remains
  `matched | ambiguous | none | unavailable`.
- `none` with `coverage.status: "complete"` is the only complete negative agent
  outcome. `none` with limited coverage remains “no reliable match,” not proof
  that no related session exists.

Malformed Git output, an unexpected Git process failure, or mutation detected
by the closing stability gate is an operational error with exit code 3, not an
`unavailable` report. Expected absent/shallow objects and supported bounds use
the typed outcomes above.

## Worktree change inspection

### Authoritative comparison

Inspection consumes the invocation's already resolved current file snapshot and
the invocation `RepositoryContext.headCommit`. It never reads the index as a
content target. It determines whether the path exists in `HEAD`, whether it is
present at index stage zero for diagnostics, and then compares `HEAD` directly
with final working-tree content at that same current path. It performs no
old-path discovery.

The cases are frozen as follows:

| Current state | Worktree behavior |
| --- | --- |
| Tracked modification, queried line added on current side | Build an `update` worktree target. |
| Tracked modification, queried line unchanged/context | Keep the line in the existing committed blame pipeline. |
| Staged modification plus later unstaged modification | Compare `HEAD` with final current content only. |
| Partially staged file | Same; index partitioning has no attribution semantics. |
| Path absent from `HEAD`, stage-zero index entry present | Treat final current content as `added`; staging is diagnostic only. |
| Intent-to-add or unstaged new path | Treat as `added` when safe final current content is available. |
| Path absent from both `HEAD` and index | Treat as `added` with `staging: "untracked"`. |
| Deleted path | Remains invalid in the current location model because no current file can be queried. |
| Unmerged path | `unavailable / unmerged`; no parent or side is selected. |
| Binary or invalid UTF-8 current file | Existing input error, exit 2. |
| Binary or invalid UTF-8 required `HEAD` material | `unavailable / incomplete-diff`. |
| Missing required `HEAD` object | `unavailable / missing-head-object`; shallow history is stated. |
| Material above a frozen bound | `work-bound`, never complete `none`. |

The current `TargetFileState` may continue classifying a staged addition as
`untracked` because the path is absent from `HEAD`. The worktree inspector owns
the more precise `changeKind` and optional staging diagnostic; it does not
reinterpret `GitProvenance` as committed.

### Current-path-only semantics and deferred renames

A worktree target has exactly one path: the canonical current repository path.
Whyline does not discover, retain, compare, or render an old path or worktree
path alias in this milestone. Path-scoped inspection cannot establish the
unknown old side of a rename, and no Codex path may supply that missing Git
fact.

If the current path is absent from `HEAD`, Whyline analyzes the current path and
content as current-side `added` material. This says only that the current path
and content are absent from the invocation `HEAD`; it does not establish that
the file was historically created rather than renamed, copied, or otherwise
introduced.

`movedFrom` has no semantic role in worktree correlation in this milestone. A
normalized change carrying it is projected as though that field were absent. It
may participate only when its remaining new-path evidence independently
satisfies an ordinary `modified` or `added` rule: exact current path, supported
operation/payload, query-local hunk, exact ordered overlap, and every normal
coverage gate. The old path contributes no alias, compatibility, score,
divergence, or supersession fact. If the ordinary current-path projection is
unsupported, incomplete, or cannot be classified without the old path, the
change contributes no signal and adds the existing material `summary-coverage`
limitation (`unclassified-patch-change` at the adapter relevance boundary)
when it could affect the target. It never becomes a negative fact.

Worktree rename provenance or correspondence is explicitly deferred to a
future milestone with its own bounded old-path discovery design. Committed Git
rename behavior, exact ancestry, and transformed direct-parent declaration
correspondence remain unchanged.

## Hunk and query locality

### Tracked paths

Worktree patch inspection uses zero context. Current-side line numbers start at
the hunk's `newStart`; added lines advance the current line and deleted lines do
not. Metadata does not participate. Because hunks are zero-context, ordinary
unchanged context is absent; if context is nevertheless present, it is mapped
as unchanged and never enters a worktree correlation target.

A queried current line is local to a tracked worktree change only when:

1. baseline worktree-aware blame marks that exact line uncommitted;
2. exactly one complete parsed `HEAD -> worktree` hunk maps it to an added
   current-side line; and
3. the current line content and digest equal the already resolved source
   snapshot at that line.

An insertion hunk with `oldLines === 0` uses Git's reported insertion point but
the queried location is always mapped through `newStart/newLines`. File-start
insertions and missing-final-newline metadata do not receive special heuristic
offsets. Adjacent hunks remain separate Git hunk identities. If Git combines
adjacent edits into one hunk, they share a target hunk but still require an exact
query-covering overlap block.

Line-number shifts do not make shifted context uncommitted. An unchanged line
whose current number moved because of an earlier insertion retains committed
blame and follows the committed pipeline.

### Range partitioning

A range may cross committed lines and any number of worktree hunks. Baseline
blame remains authoritative per line. Uncommitted lines are partitioned first
by current path/change identity and parsed worktree hunk, then into contiguous
queried runs of at most 32 lines. Each run is independently expanded within
the same added run for candidate exact-block proof. Lines from different hunks
or separated added runs never share a worktree target.

If one candidate proof block covers several queried lines, they may share one
correlation group. No result is copied to queried lines outside that exact
block. Grouping is deterministic compression, not authority.

### Target viability

Before scanning Codex, each query-local current-side run must contain or admit a
query-covering window of at most 32 lines with at least two unique distinctive
current lines and at least 40 alphanumeric characters. If no such window exists,
the group is `insufficient / insufficient-distinctive-material`. This preflight
does not assert anything about agent history and therefore is not
`CorrelationResult.status: "none"`.

## Untracked and added files

Ordinary `git diff HEAD` does not provide patch hunks for a wholly untracked
path. Whyline constructs a synthetic `HEAD -> worktree` add view from the
already verified current source snapshot only after proving that the path is
absent from `HEAD`. The same construction is used for staged additions and
intent-to-add paths, so index state cannot change the evidence semantics.

The synthetic add view has current line numbers beginning at 1, but it is not a
file-wide proof. For each queried run:

1. retain only a bounded query-containing region of at most 32 current lines;
2. require that region to admit the two-distinctive-line and 40-alphanumeric
   strength floor;
3. compare it with exactly one compatible normalized patch hunk through ordered
   exact fingerprints;
4. require the unique aligned block to contain every queried line assigned to
   the result; and
5. reject ambiguous/repeated alignments.

A successful Codex whole-file `add` is operation-compatible because it supplies
an ordered content hunk. It is not sufficient on path, success, or whole-file
identity alone. A later Codex `update` to the added file is also compatible for
a queried region only when its added-side hunk coordinates and exact ordered
fingerprints uniquely cover that region in the final current file.

If the current file or patch fingerprint coverage is too large to retain the
query-relevant material completely, the result is work-bound or limited,
never a complete negative. Generic-only files or query neighborhoods are
`insufficient`. A closing file snapshot or worktree-evidence mismatch aborts
the analysis with exit 3.

## Operation and side semantics

The worktree decision table is separate from the committed
add/update/delete table:

| Worktree target | Supported patch change | Match side | Additional requirements |
| --- | --- | --- | --- |
| `modified` | `update` + `unified-diff` | added side | Exactly one compatible patch hunk and query-covering exact alignment. |
| `added` | `add` + `content` | content | Query-local exact alignment; no whole-file promotion. |
| `added` | later `update` + `unified-diff` | added side | Hunk coordinates and exact alignment cover the queried final region. |
| Any current target | any patch change with `movedFrom` | field ignored | May use only independently complete ordinary current-path update/add evidence; the old path contributes nothing. |
| Any current target | `delete`, `unknown`, deleted side, attempt only, or unrecovered payload | none | Cannot be strong. |

The queried current line must be an added/current-side line. Deleted-side text
cannot be queried through the current location model and cannot support a
worktree positive. Context-only overlap, even within the same patch hunk, is
insufficient.

## Exact-current-worktree evidence projection

The existing candidate-level `repositoryMatch` is necessary but not sufficient
for worktree correlation because a session may visit several worktrees or
nested repositories. Worktree projection must classify each structured patch
record from its effective cwd.

A patch record is `exact-current-worktree` only when its effective cwd resolves
at analysis time through Git to the same canonical `worktreeRoot`, worktree-
specific `gitDir`, `commonGitDir`, and object format as the queried worktree.
A nested directory inside that worktree qualifies. A different linked worktree
does not, even when it shares `commonGitDir` and object IDs.

For cwd-less evidence, exact-current inheritance is allowed only when all
structurally possible effective directories for that evidence resolve to the
exact current worktree. Mixed current/linked directories, a deleted cwd, an
unknown directory, or a nested incompatible repository makes the relevant
record unresolved. It cannot contribute positive or divergence evidence. If
complete relevance scanning cannot prove that such unresolved evidence is
irrelevant to the target, it adds a material coverage limitation and can block
`matched`.

Known linked-worktree, same-common-directory, historical-commit-anchored,
deleted historical cwd, and incompatible patch records are proven not strong
for a worktree target. They are not shown as plausible alternatives. A known
repository mismatch remains a hard exclusion. Unknown identity never becomes
strong or plausible; incomplete classification remains a coverage limitation
rather than a negative fact.

Commit references are not resolved for a worktree target. The projection passes
an empty reference set, and session-head, produced-commit, and historical
commit-reference signals are disabled. A commit reference cannot repair missing
exact-worktree identity.

## Worktree candidate decision table

Committed candidates continue through the existing `scoreCandidate` and
`correlate` behavior. Worktree candidates use a separate pure scoring/gating
path so target-specific exclusions cannot alter committed weights.

A worktree candidate is **strong** if and only if all of the following hold:

1. the transcript contains a linked or self-contained, recorded successful
   supported structured patch result;
2. the contributing patch record has exact current-worktree identity;
3. the patch operation is compatible with the worktree target;
4. its normalized current `path` exactly matches the target path; any
   `movedFrom` value is ignored and contributes no evidence;
5. exactly one compatible patch hunk is local to the target hunk/region;
6. the pure overlap proof finds a unique contiguous exact alignment containing
   every queried line in the group;
7. that alignment contains at least two unique distinctive lines and at least
   40 alphanumeric characters, within 32 lines;
8. target file, target hunk, ordered target fingerprints, patch payload, patch
   hunk, and ordered patch fingerprints are complete and non-truncated;
9. no later unsuperseded structured divergence remains for that candidate; and
10. the candidate has no material candidate-specific coverage limitation.

Global selection remains:

| Strong candidates | Global coverage | Result |
| ---: | --- | --- |
| exactly 1 | sufficient/complete | `matched`, select it |
| 2 or more | any otherwise analyzable coverage | `ambiguous`, select none |
| 0, with one plausible | complete or limited | `none`, retain alternative |
| 0, no visible candidate | complete | `none`, complete negative |
| any non-selected shape | limited | existing fail-closed `none`/coverage semantics; never render as a complete negative |
| source unavailable | unavailable | `unavailable` |

Multiple strong candidates remain ambiguous even if their patches came from a
root/subagent relationship or have different timestamps. Whyline does not
collapse session identities.

A candidate may be **plausible** only with exact current-worktree identity, a
recorded successful supported patch, compatible path/operation, complete
material, and no contradiction, but without the complete exact query-local
proof. Path-only attempts, unrecorded results, one matching distinctive line,
and generic material cannot be strong. Attempts alone remain weak.

### Evidence that cannot make a worktree candidate strong

The following are supporting context at most, and several are disabled entirely
for worktree scoring:

- timestamps or temporal proximity;
- prompts, reasoning, or natural-language descriptions;
- commands, streamed input, command output, test/build/lint output, or inferred
  command success;
- session-head commit metadata;
- produced or historical commit references;
- candidate-level compatible cwd without record-level exact identity;
- linked-worktree identity;
- same-common-directory identity;
- deleted historical cwd;
- unknown/unresolved repository identity;
- path-only evidence or patch attempts;
- one distinctive matching line;
- generic, boilerplate, repeated, whitespace-normalized, case-normalized, or
  semantically similar material;
- file-level dirty or whole-file-add status by itself.

No combination of these can substitute for the ten strong gates.

## Divergence and chronology

The final current worktree is the comparison authority. Worktree divergence
uses the existing record-order principle, narrowed to exact-current-worktree,
operation-compatible, target-related structured patch results.

For one candidate session:

1. project complete supported changes onto the exact current target path in
   source record order, discarding any `movedFrom` value;
2. identify changes whose patch hunk is local to the current target region;
3. a complete later change that has at least two distinctive lines, is local to
   the same target region, and disagrees with final current material is a
   `structured-content-divergence` contradiction;
4. a still later exact matching change to the same region supersedes that
   earlier divergence;
5. unrelated-path and nonlocal-hunk changes neither diverge nor supersede;
6. truncated, unresolved-cwd, unsupported, or ambiguous-locality changes create
   coverage limitations and never divergence from absence.

Concrete consequences:

- If patch A added the queried material and no later structured patch disagrees,
  A may support strong correlation.
- If later patch B changes that same region and final content matches B, B is
  the effective direct evidence; A does not remain the final matching anchor.
- If final content matches A but a later complete B disagrees, the candidate is
  contradicted unless a still later matching patch supersedes B. Manual
  restoration is possible but is not inferred.
- If a user manually edits A's material and the final region no longer meets the
  exact proof, A is not strong. This does not prove human authorship.
- If final material partially matches A, partial similarity cannot become
  strong. Complete missing coverage remains limited/unavailable rather than a
  negative inference.
- If two sessions independently have final matching patches, the result is
  ambiguous; timestamps do not break the tie.

## Range and symbol semantics

### Separate textual and analysis grouping

Existing textual groups remain baseline Git compression. A second internal
analysis-group layer is introduced because all current uncommitted facts now
share a zero object ID and would otherwise collapse unrelated hunks.

```ts
type CorrelationAnalysisGroup =
  | {
      readonly kind: "commit";
      readonly textualGroupId: string;
      readonly spans: readonly RangeLineSpan[];
      readonly target: CommitCorrelationTarget;
    }
  | {
      readonly kind: "worktree";
      readonly textualGroupId: string;
      readonly spans: readonly RangeLineSpan[];
      readonly construction: WorktreeTargetConstruction;
    };
```

Committed groups retain their current identity and projection. Worktree groups
split by change identity, hunk identity, contiguous queried run, and exact proof
coverage. They never merge merely because their blame object is all zeros.

Range correlation status gains only the envelope value `insufficient`; the
existing `matched | ambiguous | none | unavailable | not-run | work-bound`
values retain their meanings. This is not a fifth `CorrelationResult` status.
Ancestry segments for every uncommitted span remain `not-run`, regardless of
worktree correlation outcome.

### Shared deep-analysis budget

Create committed and ready worktree analysis groups, sort them by their first
queried line in source order, and assign one shared deep ordinal. The first 24
groups receive deep analysis. Later ready groups are `work-bound / group-limit`.
The feature does not provide 24 committed plus 24 worktree groups.

Insufficient or unavailable worktree constructions are rendered but do not
consume a Codex projection slot because no projection can make them strong.
Their bounded local inspection is still subject to the file and hunk limits.

Codex preparation occurs once if at least one selected committed or ready
worktree group needs projection. Every selected group projects independently
from that prepared evidence. A worktree result is attached only to the spans
covered by its exact worktree target and proof; no range-wide or declaration-
wide promotion is permitted.

### Symbols

Symbol resolution remains the existing syntax-only current-file navigation
layer. `analyzeSymbol` continues to pass its exact one-read source snapshot and
resolved range into `analyzeResolvedRange`. A symbol query is evidence-equivalent
to the same explicit range over the same snapshot. Worktree evidence is still
line/hunk-specific; resolving a declaration never promotes one matching line to
the whole declaration.

## Codex scan lifecycle and coverage

The current staged lifecycle remains:

```text
one discovery namespace snapshot
  -> one summary-and-relevance scan per transcript
  -> target-independent repository/session preparation
  -> at most 32 potentially strong sessions per target projection
  -> target-specific exact-worktree evidence projection
  -> existing closing source/namespace stability checks
```

Mixed ranges do not rescan transcript files per group. Prepared scans retain the
new bounded per-hunk fingerprint projection so each target can use it without
reopening raw history. The agent adapter is not bypassed, and raw transcript
records never enter the provenance or renderer models.

The existing 32 potentially-strong-session cap remains per target projection.
For worktree targets, complete known linked/same-common/incompatible records can
be proven not strong before full projection. Unknown or incompletely classified
evidence that could belong to the current worktree remains potentially strong;
omitting it adds the existing material `candidate-cap` or repository coverage
limitation and blocks `matched`.

Existing compaction, rollback, abort, corrupt record, partial transcript,
changed-during-read, unsupported summary, discovery, and namespace-mutation
semantics remain. Earlier safe compaction may remain informational under the
existing record-order rules; material loss after relevant evidence blocks
selection. A readable empty store is an analyzed no-match outcome with its
existing coverage diagnostic. An unreadable source is `unavailable`.

## Stability and mutation safety

The closing stability gate is expanded for reports containing worktree targets.
Before any successful report is rendered, Whyline must verify:

1. `HEAD` still equals the invocation `baseCommitId`;
2. branch/detached state is unchanged;
3. canonical worktree root, worktree-specific Git directory, common Git
   directory, and object format are unchanged;
4. the target canonical path still resolves to the same regular-file identity
   and remains within the same worktree;
5. size, mtime, inode, device, and full source digest equal the retained
   `FileSnapshot`;
6. target status remains compatible with the retained state;
7. rerunning bounded worktree inspection yields the same current path, change
   kind, queried hunk coordinates, ordered fingerprints, completeness, and
   `evidenceDigest`; and
8. Codex transcript signatures and discovery namespace remain stable under the
   existing correlation checks.

An index-only stage/unstage operation does not invalidate a result when the
final `HEAD -> worktree` evidence digest is identical; the index has no
provenance semantics. If staging changes current-path inclusion or final
comparison evidence, the digest changes and analysis fails.

Any mismatch is `OperationalError("repository changed during analysis")` or an
equally bounded source-mutation error with exit code 3. Whyline does not retry
against a moving file and does not downgrade a stale positive to a normal
report. A positive result therefore always corresponds to the final verified
snapshot, not an intermediate state observed before Codex scanning.

## Git command boundary

All commands use the existing `GitRunner` and `GitProcess`: explicit argv,
`shell: false`, local cwd, fixed noninteractive environment, no hooks, no pager,
no color, no fetch, no remote, no config write, and `GIT_OPTIONAL_LOCKS=0`.
Transcript commands are never executed.

The new inspector may use only these read-only command families:

- `git status --porcelain=v2 -z --untracked-files=normal -- <path>` for bounded
  status diagnostics;
- `git ls-files --stage -z -- <path>` for index-presence/staging diagnostics;
- `git ls-tree -z --full-tree HEAD -- <path>` for exact `HEAD` path/blob facts;
- `git cat-file -s <validated-blob-id>` to enforce the `HEAD` blob bound before
  material comparison;
- `git cat-file blob <validated-blob-id>` to read only an already size-bounded
  required `HEAD` blob for fatal UTF-8/binary validation;
- path-scoped `git diff --raw -z --no-abbrev --no-renames --no-ext-diff
  --no-textconv HEAD -- <path>` for machine-readable path/change identity; and
- path-scoped `git diff --patch --unified=0 --no-indent-heuristic
  --no-renames --no-ext-diff --no-textconv --no-color HEAD -- <path>` for
  exact hunk coordinates and content.

Every untrusted path follows `--` as a separate argv value. Object IDs accepted
back into Git must match the repository's hexadecimal object-ID shape. Both
diff forms disable rename detection and remain scoped to the one known current
path. There is no old-path lookup, repository-wide diff, copy detection,
similarity search, or second path supplied from Codex evidence.

Unified diff is parsed as a bounded structured format because Git has no safer
machine format for line-level hunk content. Path/change identity comes from the
NUL-delimited raw format, not from `diff --stat`, localized human text, or
filename parsing. External diff and text conversion are explicitly disabled.
Git-marked binary output or an absent expected textual hunk is unavailable,
never reparsed heuristically or forced with `--text`.

Untracked and other `HEAD`-absent additions use the verified filesystem snapshot
to synthesize the bounded add view; Whyline does not use `git diff --no-index`,
temporary files, or `git hash-object`.

## Frozen bounds

Existing bounds are reused where they already govern the same material:

| Material/work | Bound | Source |
| --- | ---: | --- |
| User line range / resolved symbol range | 200 lines | Existing `MAX_RANGE_LINES`. |
| Total committed plus worktree deep-analysis groups | 24 | Existing range deep-group limit, now shared. |
| Potentially strong Codex sessions per target | 32 | Existing full-evidence candidate cap. |
| Relevant Git/worktree hunk retained lines | 256 | Existing commit hunk limit, moved to a shared hunk utility. |
| Relevant Git/worktree hunk retained raw bytes | 32 KiB | Existing commit hunk limit, moved to a shared hunk utility. |
| Target/patch line fingerprints | 128 total per hunk set/change | Existing Git and Codex fingerprint caps; not multiplied per hunk. |
| Codex structured patch payload | 256 KiB | Existing patch payload bound. |
| Codex JSONL record | 4 MiB | Existing parser record bound. |
| Exact query-local proof block | 32 lines | Reuses the exact ancestry proof window. |
| Exact proof strength | 2 unique distinctive lines and 40 alphanumeric characters | Reuses the exact ancestry strength floor. |
| Current file material eligible for worktree correlation | 2 MiB (2,097,152 bytes) | New worktree-analysis bound. |
| Required `HEAD` blob material | 2 MiB (2,097,152 bytes) | New matching worktree-analysis bound. |

The 2 MiB bound governs the new deep worktree analysis after the existing
location resolver has safely read and snapshotted the current file; it does not
change baseline location validation. `cat-file -s` applies the `HEAD` bound
before any blob material is read for this feature.

If current or `HEAD` material exceeds 2 MiB, the worktree group is
`work-bound / file-too-large`. If a relevant target hunk crosses 256 retained
lines, 32 KiB, or 128 target fingerprints, it is `work-bound / hunk-too-large`.
It is not sent to correlation. Patch payload/fingerprint truncation remains a
material correlation coverage limitation, so any `none` is visibly limited and
never rendered as a complete negative. No bound may be raised or multiplied in
this milestone to improve recall.

## Privacy and retained data

The existing privacy boundary remains:

- no raw transcript rendering;
- no prompt, reasoning, command, command output, test output, or tool output;
- no raw agent patch or worktree diff payload in public reports;
- no transcript path;
- no absolute historical cwd;
- no persistent fingerprint, session cache, index, or database;
- no network request or external upload.

Public reports may contain bounded current repository paths, current query
spans, `HEAD` prefix, change kind, staging diagnostic in details, hunk
coordinates, exact-proof counts, sanitized session ID, fixed signal wording,
coverage categories, and limitations. Raw `GitHunk.raw` remains a forensic
implementation detail for the existing committed details path and is not added
to worktree report models or rendered for worktree correlation.

## Rendering

Default output remains explanation-first. Worktree results use “current
worktree change,” not “attributed commit” or “origin.”

### Positive tracked modification

```text
src/cache.ts:88

Explanation
  Textual last-touch: uncommitted; modified against HEAD de1454b0
  Git ancestry: not run for an uncommitted line
  AI provenance: likely related Codex session 019c6a…
    successful structured patch exactly overlaps this current worktree change
```

### Positive untracked addition

```text
src/retry-policy.ts:14

Explanation
  Textual last-touch: uncommitted; file is untracked
  Git ancestry: not run for an uncommitted line
  AI provenance: likely related Codex session 019c71…
    successful structured add has exact query-local overlap with this worktree change
```

### Ambiguous

```text
  AI provenance: ambiguous; multiple strong Codex candidates
    no session selected
```

### Plausible only

```text
  AI provenance: possible related Codex session 019c6a…; evidence is insufficient
    exact current worktree and path match, but query-local exact overlap was not established
```

### Complete negative Git-only case

```text
  AI provenance: no reliable Codex match
    Coverage: complete
```

This wording is used only for `none` with complete coverage. A readable empty
store may append its existing fixed empty-store diagnostic.

### Codex history unavailable

```text
  AI provenance: unavailable
    Codex history could not be read
```

### Insufficient worktree material

```text
  AI provenance: not established; worktree material is insufficient
    the query-local change does not meet the exact distinctive-material floor
```

This is a worktree target-construction result, not agent `none`.

### Work-bound target

```text
  AI provenance: unavailable / work-bound
    the query-local worktree hunk exceeded the bounded evidence limit
```

### Unchanged line in a dirty file

Existing committed wording remains, with the dirty state visible only where it
already appears:

```text
  Textual last-touch: fb1c0f4 "feat: add Git provenance vertical slice"
  Git ancestry: not established; the textual commit may be origin or transformation
  AI provenance: no reliable Codex match
```

### Mixed range

```text
Explanation
  Textual last-touch
    40-42  fb1c0f4 "feat: add Git provenance vertical slice"
    43-44  uncommitted; modified against HEAD de1454b0
    45     uncommitted; insufficient query-local material

  Git ancestry
    40-42  not established
    43-45  not run for uncommitted lines

  AI provenance
    40-42  no reliable Codex match
    43-44  likely related Codex session 019c6a…
    45     not established; worktree material is insufficient
```

Details may add target kind, full `HEAD`, staging diagnostic, exact current path,
current hunk coordinates, proof counts, candidate signals, coverage, and
limitations. They do not render an old/moved-from path, current diff lines,
agent patch lines, or private source identifiers.

Allowed claim phrases:

- “likely related Codex session”;
- “structured patch exactly overlaps this current worktree change”;
- “possible related session”;
- “no reliable Codex match.”

Forbidden claim phrases:

- “authored by Codex”;
- “created by Codex”;
- “caused by Codex”;
- “the prompt explains why”;
- “original source” or “originated here.”

## Architecture and integration points

The expected implementation boundaries are:

- `src/git/inspect-worktree-change.ts`: read-only path/change inspection,
  current-side hunk mapping, synthetic added-file regions, bounds, and closing
  evidence snapshot;
- a shared bounded unified-diff parser/constants module extracted narrowly from
  `src/git/inspect-commit.ts`, without changing committed parsing behavior;
- `src/correlation/model.ts`: committed/worktree target union and worktree proof
  types;
- `src/correlation/worktree-overlap.ts`: pure ordered exact query-local proof;
- a target-specific worktree scorer/correlator beside the unchanged committed
  scorer, sharing only candidate/coverage utilities whose semantics are truly
  common;
- `src/agents/agent-history-source.ts` and the Codex adapter: bounded per-hunk
  fingerprint projection without raw payload retention;
- `src/provenance/correlate-codex.ts`: one preparation lifecycle, target-kind
  projection, exact record-level worktree filtering, unchanged 32-candidate cap;
- `src/provenance/explain-location.ts`: retain the committed branch and add an
  independently typed worktree branch for uncommitted blame;
- `src/provenance/explain-range.ts` and `range-model.ts`: separate analysis
  groups, shared 24-group budget, worktree envelope states, line-specific
  coverage;
- existing symbol orchestration unchanged except through the shared range core;
  and
- summary/details renderers: bounded fixed wording and privacy checks.

This feature needs no new package, parser framework, agent adapter, database,
daemon, configuration file, CLI flag, remote connector, or persistent cache.

## Compatibility

The following existing behavior is normative and must remain unchanged:

- CLI forms and argument validation;
- exit code 0 for successfully analyzed committed, uncommitted, ambiguous,
  no-match, and expected evidence-unavailable reports;
- exit code 2 for invalid/unsupported current locations;
- exit code 3 for operational failure or mutation;
- committed baseline blame and commit/parent/hunk inspection;
- committed correlation signals, weights, candidate bands, coverage,
  32-candidate cap, and decision table;
- exact Git ancestry and its precedence;
- transformed direct-parent declaration correspondence and all of its bounds;
- range textual facts and line-specific ancestry outside the new analysis-group
  partition;
- TypeScript-family symbol resolution and explicit-range equivalence;
- linked-worktree support for committed correlation only;
- final source/repository stability checks;
- privacy-safe rendering and sanitization; and
- argv-only, shell-free, offline, mutation-free Git execution.

The mere presence of dirty state must not change the report for an unchanged
queried line. A new worktree result cannot replace, modify, or lower confidence
in an existing committed result.

## Normative acceptance criteria

The milestone is complete only when all of the following pass.

### Worktree inspection and target construction

- [ ] A tracked modified queried line maps to exactly one complete current-side
  `HEAD -> worktree` update hunk and produces a ready target.
- [ ] A staged addition with unchanged working-tree content produces an added
  target from final current content.
- [ ] An untracked addition produces the same semantic added target with an
  untracked staging diagnostic.
- [ ] An intent-to-add/unstaged addition is handled as final current added
  content without index attribution.
- [ ] A partially staged file is compared only as `HEAD -> final worktree`; no
  index or staged/unstaged sub-target is created.
- [ ] An unchanged queried line in a dirty same-path file remains in the existing
  committed pipeline and has regression-equivalent output/evidence.
- [ ] A current path absent from `HEAD` is analyzed only as current-side added
  material and never rendered as proven file creation, rename, move, or copy.
- [ ] No worktree target contains or discovers an old-path alias; path-scoped
  Git inspection never expands into repository-wide rename discovery.
- [ ] Unmerged state, missing object, binary/invalid required material, and
  unsupported change shapes produce their frozen non-positive outcomes without
  fabricated attribution.
- [ ] Added/context/deleted line mapping, file-start zero-context insertion,
  missing-final-newline metadata, adjacent hunks, line-number shifts, and
  multiple hunks follow the frozen current-side locality rules.
- [ ] A file-level dirty state with no query-local current-side change cannot
  create a worktree target.

### Exact worktree overlap and operation rules

- [ ] A positive update proof uniquely aligns an exact query-covering block in
  one compatible patch hunk with at least two unique distinctive lines, 40
  alphanumeric characters, and no more than 32 lines.
- [ ] A positive add proof independently covers the queried untracked/added
  line or range; whole-file add success alone is insufficient.
- [ ] Added-file later-update evidence is positive only with exact hunk-local
  final-region coverage.
- [ ] Operation mismatch, deleted-side matching, context-only overlap,
  path mismatch, hunk-locality mismatch, ambiguous alignment, repeated/generic
  alignment, one distinctive line, and boilerplate-only material cannot be
  strong.
- [ ] A patch change carrying `movedFrom` receives no old-path alias or rename
  semantics; after that field is discarded, only independently complete
  ordinary current-path operation, locality, and exact-overlap evidence may
  qualify or participate in chronology.
- [ ] A `movedFrom` change whose remaining current-path projection is
  unsupported, incomplete, or old-path-dependent supplies no signal and adds
  the frozen material coverage limitation when it could affect the target.
- [ ] Truncated target hunk/fingerprint material becomes work-bound; truncated
  patch material becomes material limited coverage; neither becomes a complete
  negative.

### Repository identity and candidate decisions

- [ ] One strong exact-current-worktree candidate with sufficient global
  coverage returns `matched`.
- [ ] Two or more strong candidates return `ambiguous` and select none.
- [ ] One plausible candidate returns `none` and remains an alternative.
- [ ] A known repository mismatch is excluded before positive projection.
- [ ] Linked-worktree, same-common-directory, historical/deleted cwd, and
  candidate-level cwd compatibility cannot make a worktree candidate strong or
  plausible.
- [ ] A mixed-current/linked or unresolved effective cwd adds material coverage
  when it could hide target evidence and never borrows current-worktree identity.
- [ ] Timestamps, commit references, prompts, reasoning, commands, outputs,
  tests, attempts, and path-only evidence cannot satisfy a strong gate.
- [ ] Existing committed correlation decision-table tests pass unchanged apart
  from mechanical target discriminant fixture updates.

### Divergence and coverage

- [ ] A later complete local patch that disagrees with the same final target
  region contradicts an earlier match.
- [ ] A still later exact matching patch to that region supersedes the earlier
  divergence.
- [ ] A later unrelated path/hunk does not create divergence.
- [ ] Manual final edits that break exact overlap remove strong evidence without
  producing a human-authorship claim.
- [ ] Final content matching the later patch uses that direct evidence; partial
  matching never becomes strong.
- [ ] Compaction, rollback, abort, corruption, partial records, active source
  mutation, unsupported summaries, omitted potentially strong sessions, and
  the 32-candidate cap retain existing fail-closed coverage behavior.
- [ ] Empty readable and unavailable Codex stores remain distinct.

### Range, symbol, bounds, stability, and privacy

- [ ] A mixed range preserves committed unchanged lines, multiple independent
  worktree hunks, insufficient worktree lines, and work-bound groups without
  cross-promotion.
- [ ] Committed and ready worktree targets share one source-ordered 24-group
  deep-analysis budget; group 25 is work-bound.
- [ ] Uncommitted ancestry remains not-run regardless of Codex result.
- [ ] A symbol report is evidence-equivalent to its resolved explicit range and
  does not promote declaration-wide worktree evidence.
- [ ] Current and `HEAD` material above 2 MiB, target hunks above 256 lines or
  32 KiB, target fingerprint overflow above 128, and proof blocks above 32 lines
  degrade exactly as specified.
- [ ] Codex preparation/scanning occurs once per invocation, not once per range
  group; target projection reuses prepared normalized evidence.
- [ ] File mutation, `HEAD`/branch change, repository-identity change, target
  path replacement, worktree-evidence change, or material Codex source mutation
  prevents a successful stale report.
- [ ] An index-only change with identical final `HEAD -> worktree` evidence does
  not create new attribution semantics.
- [ ] Every new Git call is from the frozen read-only families, uses safe argv
  and `--`, and disables external diff, textconv, color, pager, network, hooks,
  and optional locks where applicable.
- [ ] Summary and details render every frozen positive, ambiguous, plausible,
  complete-negative, unavailable-source, insufficient-target, work-bound,
  unchanged-dirty-line, and mixed-range example without forbidden causal or
  authorship wording.
- [ ] Reports contain no raw transcript, prompt, reasoning, command, output,
  patch payload, worktree diff payload, transcript path, absolute historical
  cwd, or persistent fingerprint.
- [ ] A disposable real-Git compiled CLI fixture covers tracked modification,
  staged addition, untracked addition, partial staging, unchanged dirty line,
  positive, ambiguity, insufficient material, divergence, mixed range, symbol
  equivalence, work bound, and empty/unavailable Codex history.
- [ ] `npm run check` and `git diff --check` pass at the implementation baseline.

## Stopping condition and non-goals

When the normative acceptance criteria pass, the milestone is complete. Stop
without adding:

- another agent adapter;
- `--changed`, commit, diff-hunk, or revision-qualified queries;
- worktree Git ancestry;
- GitHub, PR, review, or first-parent integration context;
- index-specific provenance or staged/unstaged attribution;
- repository-wide path, symbol, or correspondence search;
- worktree rename, move, copy, old-path discovery, or Codex `movedFrom`
  correspondence; these require a future bounded discovery design;
- relaxed thresholds, fuzzy/normalized matching, embeddings, LLM decisions, or
  semantic similarity;
- whole-file attribution for an added/untracked file;
- persistent storage or network access.

There are no unresolved load-bearing semantic or architectural questions in
this design. Implementation planning may choose focused module and helper names,
but it may not change the target distinction, exact-current-worktree rule,
query-local proof, decision table, bounds, coverage behavior, or non-goals.
