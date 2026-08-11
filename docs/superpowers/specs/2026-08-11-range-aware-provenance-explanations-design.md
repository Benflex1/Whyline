# Range-Aware Provenance Explanations Design

**Status:** approved by the milestone brief
**Date:** 2026-08-11
**Branch:** `feat/range-aware-explanations`

## Goal

Add inclusive file-line range queries to Whyline so a single report can preserve
baseline textual Git attribution, exact Git-visible ancestry, Codex provenance,
and dirty state for a meaningful region without invoking the existing
single-line pipeline once per line.

Supported forms are:

```text
whyline <file>:<line>
whyline --details <file>:<line>
whyline <file>:<start>-<end>
whyline --details <file>:<start>-<end>
```

Ranges are positive, ordered, inclusive, at most 200 lines, and both endpoints
must exist in the current UTF-8 text file. Invalid input remains exit code 2.
Paths continue to be parsed from the final location separator, so spaces,
Unicode, colons, and single- or double-dash-leading filenames remain valid.

## Governing safety rules

The range pipeline retains one authoritative blame fact for every queried line.
Textual grouping is deterministic compression only. Its key contains every
fact required to share downstream work: committed/uncommitted state, textual
commit, blamed path, and selected parent evidence. Different commits, paths,
parents, ancestry coverage, or Codex outcomes cannot be erased by grouping.

An exact ancestry claim covers only queried lines contained in independently
successful exact proof blocks. Movement-aware blame remains candidate generation;
proper reachability, safe blob resolution, and the unchanged exact-block proof
requirements remain mandatory. Root history, shallow history, missing objects,
ambiguous merge parents, transformations, generic context, and absent proof stay
conservative. A missing proof never becomes a semantic-origin claim.

Deep range work is bounded to the first 24 committed textual groups in source
order. Later groups retain baseline attribution but receive typed
`work-bound`/`unavailable` outcomes, never `none`. Uncommitted groups are
explicitly `not-run` for ancestry and Codex.

Codex correlation semantics are frozen. The range path prepares discovery and
normalized transcript evidence once, projects that evidence independently onto
each textual target, and calls the existing candidate scoring/decision table
for each target. Thresholds, strong/possible bands, ambiguity, caps,
repository compatibility, session-head handling, coverage, privacy, and source
stability remain unchanged. The normal single-line coordinator remains
available and its behavior is regression-tested against the projection path.

## Architecture

### Query and one-read resolution

`src/location/parse-location.ts` gains a `LocationQuery` discriminated union
through a new query parser. The existing `parseLocation` single-line return
shape remains available to avoid unnecessary caller churn. A range resolver
canonicalizes the target path, reads and decodes the UTF-8 file once, validates
both endpoints and the 200-line bound, snapshots the file, and retains bounded
line content/digests for the queried span. Existing symlink, repository
containment, dirty-state, and final snapshot checks remain authoritative.

### Baseline range attribution and textual groups

`src/git/blame-range.ts` runs exactly one argv-only command equivalent to
`git blame --line-porcelain -L START,END -- PATH` for a tracked target. Its
parser consumes every porcelain record, including zero-object uncommitted
records, and returns a line-keyed fact for each requested line. Malformed
machine-readable output is an operational error.

`src/provenance/range-model.ts` owns focused range types: line spans, per-line
blame facts, textual groups, ancestry coverage segments, correlation groups,
work-bound coverage, and `WhylineRangeReport`. A textual group can contain
non-contiguous source spans, but its key includes commit, blamed path, and
selected parent evidence. Source spans are retained for rendering.

Commit inspection is batched by actual reusable evidence. Commit metadata is
loaded once per unique commit, parent selection is evaluated for each blame
fact, and differing parent evidence splits groups. Each required commit/parent
diff is run once and its relevant hunk facts are attached to the groups that
need them. No per-line commit inspection is used.

### Exact range ancestry

`src/git/trace-range-ancestry.ts` analyzes a committed textual group with one
movement-aware blame query per source span/group-level query, never one query
per line. Returned records are mapped back to the requested line facts and
partitioned into coherent candidate runs by candidate commit/path and line
continuity. Reachability checks, blob resolution, commit-subject lookup, and
blob material are memoized invocation-locally by their evidence identity.

Each candidate run is tested with the existing `proveExactBlock` primitive and
its unchanged requirements: exact character-for-character lines, queried-line
anchoring, at least two unique distinctive lines, at least 40 alphanumeric
characters, complete material, and a maximum 32-line proof window. Longer
regions use multiple windows. Successful proof windows are unioned, and only
their intersections with queried lines become `exact`. Candidate lines without
proof remain typed `uncertain`; queried lines with no candidate remain typed
`none`; material/process limitations remain typed `unavailable`. The report
renders contiguous outcome segments so partial coverage remains visible.

### Codex preparation and projection

The existing Codex coordinator is split at a narrow seam. Preparation performs
opening discovery, one summary/relevance scan per transcript, the closing
namespace stability comparison, and reusable repository/session classification.
Projection receives one prepared scan set and one `CorrelationTarget`, resolves
target-specific commit references and path aliases, projects normalized evidence,
and invokes the existing `buildCandidateInput`, `scoreCandidate`, and `correlate`
semantics. Range orchestration calls preparation once, then projection once per
eligible committed textual group within the 24-group bound. It never reopens or
rescans transcripts for each group.

If the prepared scan has global source mutation or coverage limitations, every
projected result receives the same appropriate material coverage limitation. A
projection cannot bypass the source-stability gate. Uncommitted groups do not
receive a target or Codex result.

### Range orchestration and stability

`src/provenance/explain-range.ts` follows this pipeline:

```text
parse/resolve range once
        -> one baseline range blame
        -> line attribution facts
        -> textual grouping and batched commit inspection
        -> bounded exact ancestry
        -> one prepared Codex scan and per-group projection
        -> range report
        -> final HEAD/branch/file/status verification
```

The coordinator uses one invocation-local Git memoization layer for shared
read-only metadata/object lookups without changing the single-line runner.
Baseline state, repository identity, and target snapshots are checked again at
the end. Mutation remains exit code 3.

### Rendering

Range-specific renderers keep range output separate from the single-line
renderer:

- `src/cli/render-range-summary.ts` renders the default explanation-first view.
- `src/cli/render-range-details.ts` renders bounded forensic evidence.

Each section renders at most 12 groups in summary mode and 64 in details mode.
Omissions state the exact count and recommend a narrower range. Summary output
may collapse only genuinely uniform evidence, never majority coverage. Details
show group spans, commit metadata, parents, relevant hunks, exact and uncovered
queried lines, Codex candidate evidence/coverage, uncommitted spans, and
work/history limitations without prompts, reasoning, commands, transcript
paths, or raw patch payloads.

## Data model decisions

The report has separate domains rather than a union-heavy single-line model:

```ts
interface RangeLineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

interface RangeLineAttribution {
  readonly queryLine: number;
  readonly blame: GitBlameAttribution;
}

interface RangeTextualGroup {
  readonly id: string;
  readonly spans: readonly RangeLineSpan[];
  readonly lines: readonly RangeLineAttribution[];
  readonly state: "committed" | "uncommitted";
  readonly commit: GitCommit | null;
  readonly parent: ParentSelection | null;
  readonly blamedPath: string | null;
  readonly changedPaths: readonly GitPathChange[];
  readonly relevantHunks: readonly GitHunk[];
  readonly limitations: readonly string[];
}
```

The concrete implementation may add derived fields, but it must expose
line-level facts, source spans, group identity evidence, and independent
downstream coverage. Range correlation outcomes retain the existing
`matched | ambiguous | none | unavailable` result for analyzed committed
groups and use explicit `not-run` or `work-bound` states for groups that were
not eligible for deep analysis.

## Testing strategy

Testing is TDD at each load-bearing boundary:

1. location parser/resolver tests cover valid ranges, one-line compatibility,
   same-line ranges, reversed/zero/negative/over-bound/out-of-file input, and
   unusual paths;
2. blame-range parser tests cover committed, zero-object, Unicode, malformed,
   and exactly-one-command behavior;
3. grouping/inspection tests cover contiguous and non-contiguous groups,
   mixed commits/paths/parents/uncommitted lines, renames, merge ambiguity, and
   metadata/diff deduplication;
4. range ancestry tests cover partial coverage, multiple 32-line windows,
   candidate runs, repeated/generic/transformed text, shallow/missing-object
   limitations, malformed Git failures, and the 24-group work bound;
5. Codex tests prove one discovery, one scan per transcript, different target
   projections, every existing outcome, global mutation coverage, caps, and
   equivalence with single-line correlation decisions;
6. range orchestration and renderer tests cover mixed domains, uncommitted and
   work-bound groups, explicit 12/64-group truncation, sanitization/privacy,
   and no semantic-origin wording;
7. one disposable real-Git acceptance test contains an exact moved block, a
   separately attributed committed block, and locally modified lines in one
   requested range.

The final acceptance pass is exactly the user-specified `npm run check`,
`git diff --check`, `npm run build`, and disposable range acceptance test,
followed by one bounded diff inspection. Git remains local, read-only,
argv-only, and offline throughout.

## Explicit non-goals

No symbols/functions, Tree-sitter, transformed/structural/fuzzy ancestry,
embeddings/LLMs, multi-hop relocation graphs, JSON, public schema stabilization,
new agent adapters, persistent cache/index, remote metadata, network Git,
per-line invocation of the existing pipeline, or generic provenance/plugin
framework is introduced.
