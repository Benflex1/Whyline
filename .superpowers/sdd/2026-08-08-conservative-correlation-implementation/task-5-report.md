# Task 5 implementation and self-review report

## Scope delivered

Implemented Task 5 on `feat/conservative-correlation` from `a3bd854`:

- Added `src/provenance/build-correlation-target.ts`.
- Added `src/provenance/resolve-commit-reference.ts`.
- Added `src/provenance/correlate-codex.ts`.
- Added `test/provenance-correlation-flow.test.ts`.
- Added the optional normalized `correlation` field to `WhylineReport`.
- Added analysis-only `agentHistorySource` and `codexHome` injection options.
- Integrated correlation only after committed Git provenance is established.
- The existing Codex adapter already exposed the approved `AgentEvidenceTarget`
  and diagnostic discovery seams from the preceding tasks, so no source change
  was necessary in `src/agents/codex/source.ts`.

## Implementation notes

`buildCorrelationTarget` returns `null` for non-committed provenance and copies
only repository identity/mappings, target and blamed paths, commit ID/times,
the selected parent ID, changed old/new paths, and bounded hunk coordinates and
SHA-256 line fingerprints. Commit bodies, raw hunk text, report values,
renderer state, Codex events, and transcript payloads do not enter the target.

`resolveCommitReference` compares a full object ID directly. An abbreviation is
resolved only with the current repository's argv-based
`git rev-parse --verify --quiet <prefix>^{commit}` call. Failed or ambiguous
resolution produces no target-reference signal. No remote, fetch, shell, or
transcript command is involved.

`correlateCodex` uses explicit `discoverWithDiagnostics` availability, reads
every discovered summary, classifies canonical current/linked/common-directory
repository context, excludes known incompatible repositories, and ranks only
with cheap reference/repository/time/source-path ordering. It extracts full
evidence for at most 32 eligible candidates. Unsupported summaries, discovery
diagnostics, unresolved-repository candidates, and omitted eligible candidates
remain typed coverage limitations; candidate-cap and unresolved/unsupported
counts are retained.

Uncommitted and untracked locations return before any agent-history call.
Committed locations pass only `{ repositoryPath, line, worktreeRoot }` as the
adapter hint and receive a normalized `CorrelationResult`. Empty, limited,
unavailable, unreadable, and partially extracted history preserves the Git
report and is represented through typed correlation coverage.

## TDD evidence

The new flow test was written before the integration seam. The initial build
failed with the expected missing `agentHistorySource` option and missing
`WhylineReport.correlation` property. After implementation, the same focused
flow command passed all three cases:

```text
npm run build && node --test dist/test/provenance-correlation-flow.test.js
3 passed, 0 failed
```

The cases cover uncommitted early return, untracked early return, and committed
correlation with a fake source, synthetic home context, bounded extraction hint,
and normalized matched result.

## Self-review checklist

- Git provenance facts remain in their existing model; correlation is optional
  and separate.
- Only committed provenance can trigger discovery.
- Current, linked, and same-common-directory contexts receive positive
  classification; a known different common Git directory is incompatible;
  missing/deleted working directories remain unknown without positive path
  evidence.
- Full and abbreviated commit references use the current repository only.
- Session-head metadata remains contextual; the pure Task 3/4 scorer still
  controls signals, bands, contradictions, and final selection.
- Summary discovery is unbounded; full extraction is capped at 32 eligible
  candidates and omitted candidates are never silently treated as unrelated.
- The rich Git target and adapter hint are separate, and no raw transcript or
  patch source is retained in the correlation target.
- The flow performs no remote access, shell parsing, transcript command
  execution, or mutation-capable Git operation.
- Task 6 rendering and Task 7 end-to-end expansion were not started.

## Verification

Fresh verification completed before commit:

```text
npm run typecheck
passed

npm run build
passed

npm run build && node --test dist/test/provenance-correlation-flow.test.js
3 passed, 0 failed

npm run check
72 passed, 0 failed; exit code 0
```

`git diff --check` was clean during review. The full check used fixture-owned,
injected synthetic Codex homes for committed Git tests; uncommitted and
untracked flow cases made zero discovery calls as required.

## Fix round 1/5

### Reviewer findings addressed

1. Compaction, rollback, and abort diagnostics are no longer promoted to
   material coverage during summary staging, where direct evidence record
   positions are not yet available. The diagnostics remain in the projected
   session/evidence contracts. Task 4's chronology-aware scorer classifies
   them after extraction: diagnostics before a relevant direct record are
   informational, while later or position-unknown compaction/rollback/abort
   diagnostics remain material. Partial/corrupt and changed-during-read
   diagnostics remain material immediately.

2. Historical session-head context now requires
   `ResolvedCommitReference.resolution === "other"`. Target, ambiguous, and
   unresolved references cannot produce the historical-reference signal. The
   decision-table regression preserves the positive `other` case and tests
   both negative resolutions.

3. Every committed-path test in `test/git-provenance.test.ts` now receives a
   fixture-owned, empty synthetic Codex home through both the Git runner
   environment and `AnalyzeLocationOptions.codexHome`. CLI subprocess tests
   inherit the same fixture environment, so automated tests cannot inspect the
   developer's real Codex profile.

4. The coordinator now projects summaries to session identity, timestamps,
   safe commit-reference metadata, partial state, and typed diagnostics. It
   removes initial/working directories and replaces transcript source paths
   with an opaque non-filesystem marker. Evidence projection removes absolute
   cwd values and normalizes in-worktree absolute evidence paths to relative
   paths; outside absolute paths are dropped. Pure `correlate` ordering no
   longer reads or sorts `sourcePath`. Repository classification and raw
   source handles remain in the orchestration layer.

5. `test/provenance-correlation-flow.test.ts` now covers available/limited/
   unavailable discovery, earlier and later diagnostics, current-worktree
   classification, privacy of projected correlation data, the 32-candidate
   extraction cap, omitted eligible coverage, an unresolved repository
   candidate, and the existing uncommitted/untracked early-return and narrow
   target-hint behavior. Existing mutation-hook and linked-worktree Git tests
   continue to run with the synthetic Codex home.

### Self-review

- No Git facts were changed; `WhylineReport.correlation` remains optional and
  separate from provenance.
- No raw transcript path, cwd, working-directory list, prompt, command,
  output, patch payload, or renderer/report object enters pure correlation.
- Reference resolution remains current-repository-only and argv-only; no
  remote, shell parsing, network, or mutation-capable Git call was added.
- Uncommitted and untracked locations still return before discovery.
- Candidate-cap and unresolved-candidate limitations remain material so a
  potentially strong candidate is never silently treated as disproven.
- Worktree/common-directory classification stays in the coordinator, with a
  known different common Git directory excluded and missing paths unable to
  create a positive signal.
- Tasks 6 and 7 were not started.

### Fix-round verification

Focused regression run:

```text
npm run build && node --test dist/test/correlation-decision-table.test.js dist/test/provenance-correlation-flow.test.js dist/test/git-provenance.test.js
43 passed, 0 failed
```

Fresh repository verification:

```text
npm run typecheck   passed
npm run build       passed
npm test            75 passed, 0 failed
npm run check       75 passed, 0 failed
git diff --check    passed
```

## Fix round 2/5

### Reviewer findings addressed

1. `classifyRepository` now checks an absolute transcript cwd against the
   normalized current worktree root and exact linked-worktree mapping paths
   before attempting `realpath`. A deleted/prunable linked checkout therefore
   retains its `linked-worktree` identity from Git's parsed mapping. Arbitrary
   missing or unresolvable paths do not match a mapping and still produce no
   positive repository signal. No basename or other broadened identity rule
   was introduced.

2. Corrected the accumulated verification wording above: committed Git tests
   use fixture-owned, injected synthetic Codex homes, and do not use the real
   local Codex profile.

### Regression and self-review

Added a real Git integration regression that creates a detached linked
worktree, removes its checkout without removing the administrative mapping,
verifies Git reports it as prunable, and correlates a session whose cwd is the
deleted mapping path. The result must remain matched with
`repositoryMatch: "linked-worktree"`.

The change remains within Task 5. Git provenance facts, source projection,
reference resolution, scoring, renderer boundaries, and Tasks 6/7 were not
otherwise changed. The mapping check is lexical normalization only and the
fallback remains the existing realpath/common-Git-dir path for arbitrary
existing directories.

### Fix-round 2 verification

```text
Focused: npm run build && node --test dist/test/correlation-decision-table.test.js dist/test/provenance-correlation-flow.test.js dist/test/git-provenance.test.js
44 passed, 0 failed

npm run typecheck   passed
npm run build       passed
npm test            76 passed, 0 failed
npm run check       76 passed, 0 failed
git diff --check    passed
```

## Fix round 3/5

### Reviewer finding addressed

`correlate` now scores eligible candidates before deriving the final global
coverage. Input-supplied limitations are merged once as before. Newly derived
material candidate limitations—such as chronology-material compaction and
truncated Git hunk evidence—are then merged into global coverage and promote
its status to `limited`. Informational candidate limitations remain on their
candidate only, and input limitations are excluded from the derived merge so
counts and candidate/global separation are preserved.

Unavailable coverage still returns `unavailable` before scoring, and an
available empty store remains `complete` with its non-material empty-store
limitation. Candidate results retain their own limitation lists for the
selection and alternatives contract.

### Regression and self-review

Added a decision-table regression covering both a later compaction diagnostic
and a truncated relevant Git hunk. Each case verifies that the result remains
`none`, the selected candidate retains its material limitation, and returned
global coverage is also `limited` with the corresponding typed limitation.

The change is confined to pure correlation coverage propagation and its tests;
no Git facts, Codex discovery behavior, renderer behavior, or Task 6/7 work
was changed.

### Fix-round 3 verification

```text
Focused: npm run build && node --test dist/test/correlation-decision-table.test.js dist/test/provenance-correlation-flow.test.js dist/test/git-provenance.test.js
45 passed, 0 failed

npm run typecheck   passed
npm run build       passed
npm test            77 passed, 0 failed
npm run check       77 passed, 0 failed
git diff --check    passed
```

## Fix round 4/5

### Reviewer findings addressed

1. `mappedWorktreeMatch` now compares normalized absolute paths using
   containment for non-current linked worktree mappings. A listed/prunable
   linked checkout therefore preserves `linked-worktree` identity for a
   historical cwd below that mapping even when the nested directory was
   deleted. The current worktree still requires its exact mapped root before
   `realpath`, and arbitrary deleted paths outside a linked mapping remain
   `unknown`; no basename or filename inference was added.

2. `buildCorrelationTarget` now records whether bounded added/deleted Git
   fingerprint extraction omitted lines and folds that fact into the
   normalized hunk's `truncated` flag. Fingerprints remain SHA-256, bounded,
   and raw-free; parser-level truncation is preserved.

3. `correlate` now merges the target-level `truncated-git-hunk` limitation into
   global coverage before the unavailable and selection gates. A truncated
   relevant target therefore remains material/limited even when no candidate
   is eligible or scored, while candidate-derived limitations and existing
   unavailable semantics remain unchanged.

### Regression and TDD evidence

Added focused regressions for the nested deleted linked cwd in
`test/provenance-correlation-flow.test.ts`, bounded raw-free Git fingerprints
in `test/provenance-correlation-target.test.ts`, and zero-candidate target
coverage in `test/correlation-decision-table.test.ts`.

The initial RED run failed for the expected reasons: the nested cwd classified
as `unknown`, bounded target extraction returned `truncated: false`, and zero
candidates left global coverage `complete`. The same focused tests passed after
the minimal fixes. Existing prunable-root, unknown-cwd, candidate-derived
coverage, patch-overlap, Git provenance, and privacy/read-only semantics remain
covered by the existing suite. Tasks 6 and 7 were not started.

### Fix-round verification

```text
Focused: npm run build && node --test dist/test/correlation-decision-table.test.js dist/test/provenance-correlation-flow.test.js dist/test/provenance-correlation-target.test.js
18 passed, 0 failed

npm test
79 passed, 0 failed

npm run check
79 passed, 0 failed; typecheck passed

npm run typecheck
passed

npm run build
passed

git diff --check
passed
```
