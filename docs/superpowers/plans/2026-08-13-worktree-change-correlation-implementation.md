# Conservative Worktree-Change Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conservatively correlate an uncommitted queried line or range with exact, query-local, successful Codex structured patch evidence against the final verified `HEAD -> working tree` change, without treating that change as a commit or weakening committed provenance.

**Architecture:** Add an independently typed worktree target built by a bounded, current-path-only Git inspector, then project the existing one-scan Codex evidence into a separate exact-worktree scorer and selector. Preserve textual blame as the per-line authority, add a second range analysis-group layer for individual worktree hunks/runs, and close every worktree result with repository, file, target-evidence, and Codex-source stability validation.

**Tech Stack:** TypeScript 5.9, Node.js 24, ESM, built-in `node:test`, existing `GitRunner`/`GitProcess`, existing Codex staged discovery and normalized transcript adapter.

**Canonical baseline:** `2c30355b647d72e828868a372bde95da71c84325`

**Normative design:** `docs/superpowers/specs/2026-08-13-worktree-change-correlation-design.md`

## Global Constraints

- A worktree target is not a commit. It has no commit attribution, parent, Git ancestry, origin, or authorship fields.
- `HEAD -> final working-tree content` is authoritative. The index is diagnostic only; there is no staged/unstaged attribution or index target.
- Worktree targets have only `changeKind: "modified" | "added"` and one exact current repository path.
- There is no worktree rename/move/copy support, old-path discovery, path alias, or repository-wide search. Every worktree diff command uses `--no-renames`.
- Codex `movedFrom` is discarded only in worktree projection. It supplies no path, score, operation, chronology, divergence, or supersession evidence. Existing committed use of `movedFrom` stays unchanged.
- A path absent from `HEAD` is current-side `added` material only; reports must not claim file creation, rename, move, or copy.
- Positive overlap requires one unique contiguous alignment in one compatible patch hunk, every queried line covered, no more than 32 lines, at least 2 unique distinctive exact lines, at least 40 Unicode alphanumeric characters, and exact whitespace/case/order.
- Strong worktree evidence requires a successful supported structured patch result, record-level exact current-worktree identity, exact path and operation, complete target and patch evidence, no unsuperseded divergence, no material candidate limitation, and complete global coverage.
- `CorrelationResult.status` remains exactly `matched | ambiguous | none | unavailable`. Target construction separately remains `ready | insufficient | unavailable | work-bound`.
- Existing committed candidate weights, bands, decision table, aliases, references, linked-worktree handling, 32-candidate cap, coverage, and rendering are a frozen regression boundary.
- Baseline blame remains per-line truth. An unchanged queried line in a dirty file follows the existing committed pipeline with regression-equivalent evidence and output.
- Symbols remain evidence-equivalent to their resolved explicit ranges; no declaration-wide worktree promotion is allowed.
- Codex history is discovered/scanned once per invocation and projected independently per selected target. Raw history is not rescanned per range group.
- Frozen bounds are: 200 queried/resolved-symbol lines; 24 total source-ordered committed plus ready-worktree deep groups; 32 potentially strong Codex sessions per target; 2 MiB current material; 2 MiB required `HEAD` blob; 256 retained hunk lines; 32 KiB retained hunk bytes; 128 fingerprints total per governed target hunk set or patch change; 256 KiB patch payload; 4 MiB JSONL record; 32 proof lines; 2 unique distinctive lines; 40 alphanumeric characters.
- Bounds, truncation, unresolved identity, corruption, and omitted candidates never become a false complete `none`.
- New Git work is path-scoped, argv-only, `shell: false`, read-only, offline, hook-free, pager-free, color-free, optional-lock-free, and disables external diff/textconv. It never uses `diff --no-index`, temporary comparison files, `hash-object`, fetch, writes, or a repository-wide diff/search.
- Reports expose no raw transcript, prompt, reasoning, command, command/test output, patch, worktree diff, transcript path, absolute historical cwd, or fingerprint. Fingerprints remain invocation-local and ephemeral.
- Allowed claims are “likely related Codex session,” “successful structured patch exactly overlaps this current worktree change,” “possible related session,” and “no reliable Codex match.” Never claim “authored,” “created,” “caused,” “origin,” or that a prompt explains the code.
- Mutation of `HEAD`, branch/detached state, repository identity, target identity/content, worktree evidence, or material Codex source state aborts with exit 3. Do not retry or downgrade stale evidence into a report. An index-only change is harmless when the authoritative evidence digest is unchanged.

---

## File Structure / Responsibility Map

### Files to create

- `src/git/bounded-unified-diff.ts` — shared 256-line/32-KiB structured unified-diff parser and constants; committed inspection re-exports the existing parser API from this module.
- `src/git/inspect-worktree-change.ts` — current-path-only `HEAD -> worktree` inspection, staging diagnostics, synthetic HEAD-absent add views, query-to-hunk partitioning, bounds, and evidence digests.
- `src/correlation/worktree-overlap.ts` — pure exact ordered fingerprint proof for one worktree hunk and one normalized patch hunk.
- `src/correlation/score-worktree-candidate.ts` — worktree-only possibility classification, strong/plausible/weak gating, and chronology/divergence; no committed weights or aliases.
- `src/correlation/correlate-worktree.ts` — worktree candidate selection and global coverage merge using the existing four result statuses.
- `src/provenance/verify-analysis-stability.ts` — shared closing verification for the existing repository/file facts plus optional worktree evidence and prepared Codex source snapshots.
- `test/worktree-change-git.test.ts` — pure parser plus disposable real-Git target-construction and safe-command tests.
- `test/worktree-overlap.test.ts` — exact alignment, locality, operation, distinctiveness, ambiguity, and truncation tests.
- `test/worktree-correlation-decision-table.test.ts` — exact-worktree identity, `movedFrom`, candidate outcomes, divergence, and coverage tests.
- `test/worktree-provenance-flow.test.ts` — single-line orchestration, mutation safety, rendering, and committed dirty-line regression tests.
- `test/worktree-range-provenance.test.ts` — mixed ranges, multiple hunks, shared group budget, no span promotion, and symbol equivalence tests.
- `test/worktree-acceptance.test.ts` — compiled CLI acceptance over disposable repositories and synthetic local Codex history.

### Files to modify materially

- `src/correlation/model.ts` — committed/worktree target union, worktree hunk/proof/construction types, and exact repository identity.
- `src/agents/agent-history-source.ts` — bounded per-hunk normalized patch evidence and optional source-signature verification contract.
- `src/agents/codex/extract-evidence.ts`, `src/agents/codex/source.ts` — per-hunk extraction under the existing shared 128-fingerprint cap and closing source-signature checks.
- `src/provenance/correlate-codex.ts` — preserve one preparation pass, dispatch commit/worktree projections, perform record-level exact-worktree classification, retain the 32-session cap, and expose closing prepared-source verification.
- `src/provenance/explain-location.ts`, `src/provenance/explain-range.ts`, `src/provenance/range-model.ts`, `src/provenance/model.ts` — worktree orchestration/report envelope, second analysis grouping, shared 24-group budget, and closing verification.
- `src/location/resolve-location.ts` — expose a single-line-from-current-source constructor so inspection consumes the same one-read source snapshot as the query.
- `src/cli/render-summary.ts`, `src/cli/render-text.ts`, `src/cli/render-correlation.ts`, `src/cli/render-range-summary.ts`, `src/cli/render-range-details.ts` — fixed explanation-first worktree wording and bounded details without changing committed rendering.

### Files with mechanical compatibility changes only

- `src/provenance/build-correlation-target.ts`, `src/correlation/build-candidates.ts`, `src/correlation/correlate.ts`, `src/correlation/score-candidate.ts`, `src/correlation/patch-overlap.ts` — type existing code explicitly to `CommitCorrelationTarget`; do not change committed logic.
- Existing committed correlation fixtures in `test/correlation-decision-table.test.ts`, `test/correlation-patch.test.ts`, `test/correlation-e2e.test.ts`, `test/provenance-correlation-target.test.ts`, and `test/provenance-correlation-flow.test.ts` — add only the `kind: "commit"` and worktree-specific Git-directory identity required by the new committed target shape, except where a test explicitly changes because uncommitted analysis no longer stops before Codex.

The plan deliberately keeps worktree inspection, overlap proof, and candidate scoring in separate files. Git establishes the current-side fact, the pure proof establishes exact overlap, and the scorer decides whether a session may be called strong; none can silently substitute for another.

---

### Task 1: Introduce the target union and preserve committed behavior mechanically

**Files:**
- Modify: `src/correlation/model.ts`
- Modify: `src/provenance/model.ts`
- Modify: `src/provenance/range-model.ts`
- Modify: `src/provenance/build-correlation-target.ts`
- Modify mechanically: `src/correlation/build-candidates.ts`
- Modify mechanically: `src/correlation/correlate.ts`
- Modify mechanically: `src/correlation/score-candidate.ts`
- Modify mechanically: `src/correlation/patch-overlap.ts`
- Modify fixtures: `test/correlation-decision-table.test.ts`
- Modify fixtures: `test/correlation-patch.test.ts`
- Modify fixtures: `test/correlation-e2e.test.ts`
- Modify fixtures: `test/provenance-correlation-target.test.ts`

**Interfaces:**
- Consumes: existing `RepositoryContext`, `FileSnapshot`, `RangeLineSpan`, `CorrelationHunk`, `CorrelationResult`, and committed target fields.
- Produces:

```ts
export interface CorrelationRepositoryIdentity {
  readonly worktreeRoot: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly objectFormat: string;
  readonly worktrees: readonly {
    readonly path: string;
    readonly commonGitDir: string;
  }[];
}

export interface CommitCorrelationTarget {
  readonly kind: "commit";
  readonly repository: CorrelationRepositoryIdentity;
  // Existing targetPath/blamedPath/commit/selectedParentId/changedPaths/relevantHunks.
}

export interface WorktreeCorrelationHunk extends CorrelationHunk {
  readonly basis: "derived";
  readonly operation: "update" | "add";
  readonly queriedSpans: readonly RangeLineSpan[];
  readonly currentLineFingerprints: readonly string[];
  readonly currentDistinctiveLineFingerprints: readonly string[];
  readonly currentLineAlphanumericCounts: readonly number[];
  readonly complete: true;
}

export interface WorktreeCorrelationTarget {
  readonly kind: "worktree";
  readonly basis: "derived";
  readonly repository: CorrelationRepositoryIdentity;
  readonly baseCommitId: string;
  readonly targetPath: string;
  readonly changeKind: "modified" | "added";
  readonly staging: "staged" | "unstaged" | "partially-staged" | "untracked" | "unknown";
  readonly queriedSpans: readonly RangeLineSpan[];
  readonly relevantHunks: readonly [WorktreeCorrelationHunk];
  readonly targetSnapshot: WorktreeTargetSnapshot;
}

export type ProvenanceCorrelationTarget =
  | CommitCorrelationTarget
  | WorktreeCorrelationTarget;

export type WorktreeTargetConstruction =
  | { readonly status: "ready"; readonly queriedSpans: readonly RangeLineSpan[]; readonly target: WorktreeCorrelationTarget }
  | { readonly status: "insufficient"; readonly queriedSpans: readonly RangeLineSpan[]; readonly reason: "query-not-current-side-change" | "insufficient-distinctive-material"; readonly limitations: readonly string[] }
  | { readonly status: "unavailable"; readonly queriedSpans: readonly RangeLineSpan[]; readonly reason: "unmerged" | "unsupported-change-shape" | "missing-head-object" | "incomplete-diff"; readonly limitations: readonly string[] }
  | { readonly status: "work-bound"; readonly queriedSpans: readonly RangeLineSpan[]; readonly reason: "file-too-large" | "hunk-too-large" | "group-limit"; readonly limitations: readonly string[] };
```

- `WhylineReport.correlation` remains the committed `CorrelationResult`; add a separate `worktreeCorrelation?: WorktreeCorrelationReport` whose public fields contain only target kind, HEAD, current path/change kind/staging, covered spans, bounded hunk coordinates/proof counts, status/result, and limitations—never fingerprints or raw diff material.
- Add `RangeCorrelationStatus` value `insufficient`. Extend `RangeCorrelationGroup` with `analysisGroupId`, `textualGroupId`, and `targetKind: "commit" | "worktree"`; keep ancestry keyed by the existing textual group ID.

- [ ] **Step 1: Add compile-time model tests and committed fixture discriminants.** Update committed target builders with `kind: "commit"` and `repository.gitDir`, then add assertions in `test/provenance-correlation-target.test.ts` that `buildCorrelationTarget` returns a commit target with unchanged committed facts. Add type-level construction fixtures for every `WorktreeTargetConstruction` branch and assert no worktree target accepts `commit`, `selectedParentId`, `blamedPath`, `changedPaths`, or `pathAliases`.
- [ ] **Step 2: Run the focused model/decision suites red.** Run `npm run build && node --test dist/test/provenance-correlation-target.test.js dist/test/correlation-decision-table.test.js dist/test/correlation-patch.test.js`. The expected initial failures are missing discriminants/types, followed by green committed assertions after the mechanical change.
- [ ] **Step 3: Add the discriminated types and public worktree report envelope.** Keep `CorrelationResult` and all committed candidate/result shapes unchanged. Use `CommitCorrelationTarget` in every existing committed scorer/overlap/correlation signature; only orchestration accepts `ProvenanceCorrelationTarget` later.
- [ ] **Step 4: Update `buildCorrelationTarget` mechanically.** Return `kind: "commit"`, copy `RepositoryContext.gitDir`, and preserve all existing path, parent, hunk, and fingerprint construction byte-for-byte.
- [ ] **Step 5: Prove the committed regression boundary.** Run `npm run build && node --test dist/test/correlation-decision-table.test.js dist/test/correlation-patch.test.js dist/test/correlation-e2e.test.js dist/test/provenance-correlation-target.test.js`. Do not change weights, expected bands, signals, aliases, references, or selection expectations to make this pass.
- [ ] **Step 6: Commit the domain boundary.** Run `git add src/correlation src/provenance/model.ts src/provenance/range-model.ts src/provenance/build-correlation-target.ts test/correlation-decision-table.test.ts test/correlation-patch.test.ts test/correlation-e2e.test.ts test/provenance-correlation-target.test.ts && git commit -m "feat: model worktree correlation targets"`.

### Task 2: Build bounded current-path worktree targets from real Git facts

**Files:**
- Create: `src/git/bounded-unified-diff.ts`
- Create: `src/git/inspect-worktree-change.ts`
- Modify: `src/git/inspect-commit.ts`
- Modify: `src/location/resolve-location.ts`
- Create: `test/worktree-change-git.test.ts`
- Extend: `test/git-provenance.test.ts`
- Extend: `test/git-blame-range.test.ts`

**Interfaces:**
- Consumes: `GitRunner`, `RepositoryContext`, `CurrentSourceSnapshot`, and a sorted unique list of queried current line numbers already marked uncommitted by baseline blame.
- Produces:

```ts
export const MAX_RETAINED_DIFF_HUNK_LINES = 256;
export const MAX_RETAINED_DIFF_HUNK_BYTES = 32 * 1024;

export function parseBoundedUnifiedDiff(
  value: Buffer,
  targetLines: number | ReadonlySet<number>,
): GitHunk[];

export interface WorktreeChangeInspection {
  readonly repositoryPath: string;
  readonly baseCommitId: string;
  readonly constructions: readonly WorktreeTargetConstruction[];
  /** Digest excludes staging metadata and includes path/kind/hunk coordinates/completeness/fingerprints. */
  readonly evidenceDigest: string;
}

export async function inspectWorktreeChange(
  runner: GitRunner,
  repository: RepositoryContext,
  source: CurrentSourceSnapshot,
  queriedLines: readonly number[],
): Promise<WorktreeChangeInspection>;

export function resolvedCodeLocationFromSource(
  parsed: ParsedLocation,
  source: CurrentSourceSnapshot,
): ResolvedCodeLocation;
```

- `inspectCommit.ts` re-exports `parseUnifiedDiff` from `bounded-unified-diff.ts` so existing imports/tests remain compatible. Existing committed diff argv and parsing behavior do not change.
- The inspector emits one construction per same-hunk, same-added-run, contiguous queried run of at most 32 lines. Every construction carries its own queried spans; unrelated all-zero blame lines never collapse.

- [ ] **Step 1: Write parser extraction regressions first.** Copy the existing parser cases into `test/worktree-change-git.test.ts` and assert identical committed parsing for added/deleted/context/metadata lines, file-start `@@ -0,0 +1,n @@`, missing-final-newline metadata, adjacent/multiple hunks, unusual paths, 256-line truncation, and 32-KiB truncation. Run `npm run build && node --test dist/test/worktree-change-git.test.js dist/test/git-provenance.test.js`; expect the new module export to be missing while old tests remain green.
- [ ] **Step 2: Extract the parser and constants without changing committed behavior.** Move only `HunkBuilder`, path-marker parsing, line accounting, `finishHunk`, the two existing bounds, and `parseUnifiedDiff`. Keep `inspect-commit.ts`’s current `--find-renames --unified=3` flow and public re-export unchanged.
- [ ] **Step 3: Add disposable Git target-construction tests before the inspector.** Cover tracked current-side update, staged add, untracked add, intent-to-add, partial staging, staged-then-unstaged modification, unchanged dirty line, HEAD-absent current path, unmerged path, deleted current path rejection by the existing resolver, binary/invalid-UTF-8 current input, binary/invalid-UTF-8 required HEAD material, missing HEAD blob, unsupported raw/patch shape, multiple/adjacent hunks, file-start insertion, deleted/context mapping, line-number shifts, and a path whose former name exists only elsewhere in the repository.
- [ ] **Step 4: Assert the exact safe command envelope.** Record all calls and require only `status --porcelain=v2 -z --untracked-files=normal -- <path>`, `ls-files --stage -z -- <path>`, `ls-tree -z --full-tree HEAD -- <path>`, size-first bounded `cat-file`, path-scoped `diff --raw -z --no-abbrev --no-renames --no-ext-diff --no-textconv HEAD -- <path>`, and path-scoped `diff --patch --unified=0 --no-indent-heuristic --no-renames --no-ext-diff --no-textconv --no-color HEAD -- <path>`. Assert no second path, `--find-renames`, `--no-index`, `hash-object`, temp file, repository-wide diff, write, hook, pager, or network command.
- [ ] **Step 5: Add the one-read single-line resolver seam.** Implement `resolvedCodeLocationFromSource` with the same line bounds, retained 4096-character display text, digest, target state, and snapshot fields as `resolveLocation`; have `resolveLocation` delegate to it. Existing location behavior must remain unchanged.
- [ ] **Step 6: Implement HEAD/path/index diagnostics.** Parse NUL-delimited status, stage entries, `ls-tree`, and raw diff strictly. Validate object IDs against the repository object format before `cat-file -s`; read a required blob only after it is at most 2,097,152 bytes. Treat staging only as `staged | unstaged | partially-staged | untracked | unknown`; do not put staging in the authoritative evidence digest.
- [ ] **Step 7: Implement tracked zero-context mapping.** Require baseline-uncommitted queried lines to map to added/current-side lines in exactly one complete same-path `HEAD -> worktree` hunk. Deleted and context lines never enter a target. Split by hunk, added run, contiguity, and 32-line query runs; reconstruct current line numbers from `newStart/newLines` without positional heuristics.
- [ ] **Step 8: Implement HEAD-absent synthetic add views.** Prove only that the exact current path is absent from `HEAD`, then construct bounded query-containing current-side content regions from `CurrentSourceSnapshot`. Use the same behavior for staged additions, intent-to-add, and untracked files. Do not inspect or retain an old path and do not label the file “created.”
- [ ] **Step 9: Apply viability and material bounds.** Reuse `isDistinctiveLine`, SHA-256 exact line digests, the 32-line proof window, two-distinctive/40-alphanumeric floor, shared 128 target fingerprints, 256 hunk lines, and 32 KiB hunk bytes. Current or required HEAD material above 2 MiB is `work-bound/file-too-large`; target hunk/fingerprint overflow is `work-bound/hunk-too-large`; complete generic neighborhoods are `insufficient/insufficient-distinctive-material`; expected missing objects/shapes use the frozen typed unavailable reasons.
- [ ] **Step 10: Run focused Git and blame tests.** Run `npm run build && node --test dist/test/worktree-change-git.test.js dist/test/git-provenance.test.js dist/test/git-blame-range.test.js`. Confirm shifted unchanged lines retain committed blame and file dirtiness alone never creates a worktree target.
- [ ] **Step 11: Commit the inspector.** Run `git add src/git/bounded-unified-diff.ts src/git/inspect-worktree-change.ts src/git/inspect-commit.ts src/location/resolve-location.ts test/worktree-change-git.test.ts test/git-provenance.test.ts test/git-blame-range.test.ts && git commit -m "feat: inspect bounded worktree changes"`.

### Task 3: Prove exact query-local overlap independently of scoring

**Files:**
- Create: `src/correlation/worktree-overlap.ts`
- Create: `test/worktree-overlap.test.ts`

**Interfaces:**
- Consumes: one complete `WorktreeCorrelationTarget`, one `AgentPatchChange`, and one `AgentPatchHunkEvidence` selected from that change.
- Produces:

```ts
export interface WorktreeOverlapInput {
  readonly target: WorktreeCorrelationTarget;
  readonly change: AgentPatchChange;
  readonly patchHunk: AgentPatchHunkEvidence;
}

export function proveWorktreeOverlap(
  input: WorktreeOverlapInput,
): WorktreeOverlapResult;
```

- The function is pure. It checks exact current path, the separate worktree operation table, patch-hunk/current-hunk locality, unique ordered alignment, complete query coverage, and proof strength. It never sees timestamps, repositories, commits, sessions, prompts, or raw text.

- [ ] **Step 1: Write the complete red decision matrix.** Add cases for modified/update and added/add positives; added/later-update positive; every queried line covered; two queried spans inside one exact block; query outside block; different target/patch hunks; operation/path/deleted-side/context mismatch; repeated alignment; one distinctive line; two distinctive lines below 40 alphanumerics; boilerplate/generic-only lines; whitespace/case/order differences; 33-line block; target incomplete; patch incomplete; and fingerprint truncation.
- [ ] **Step 2: Run the proof test red.** Run `npm run build && node --test dist/test/worktree-overlap.test.js`; expect the missing module/function failure.
- [ ] **Step 3: Implement side-aware compatibility first.** `modified` accepts only `update + unified-diff + added`; `added` accepts `add + content + content` or a later `update + unified-diff + added`. Reject delete, unknown, attempt-only, unrecovered payload, and deleted/content-only mismatches before fingerprint search.
- [ ] **Step 4: Implement hunk locality.** For update evidence, require the patch hunk’s current/new-side range to be compatible with the target current-side hunk and queried spans. For a synthetic whole-file add hunk, allow content alignment anywhere in the added file but require the unique aligned block itself to cover the target query. Never join separate patch hunks or target added runs.
- [ ] **Step 5: Implement unique exact alignment.** Compare ordered SHA-256 fingerprints without normalization. Enumerate contiguous target/patch alignments within the one hunk, expand around queried lines only within the same added run to at most 32 lines, and accept exactly one alignment that contains every queried span. No position, score, timestamp, or nearest-line tie-breaker is allowed.
- [ ] **Step 6: Calculate strength from target metadata.** Count unique distinctive target fingerprints and sum the parallel target alphanumeric counts for the exact aligned block. Require at least 2 and 40 respectively. Return only bounded coordinates/counts/covered spans; never return line text or fingerprints in `WorktreeOverlapResult`.
- [ ] **Step 7: Run the proof suite and commit.** Run `npm run build && node --test dist/test/worktree-overlap.test.js`, then `git add src/correlation/worktree-overlap.ts test/worktree-overlap.test.ts && git commit -m "feat: prove exact worktree overlap"`.

### Task 4: Retain bounded per-hunk Codex evidence without changing committed flattening

**Files:**
- Modify: `src/agents/agent-history-source.ts`
- Modify: `src/agents/codex/extract-evidence.ts`
- Modify: `src/agents/codex/safe.ts`
- Extend: `test/codex-history.test.ts`
- Extend: `test/codex-range-projection.test.ts`

**Interfaces:**
- Consumes: supported recovered `unified_diff` or `content` payloads inside the existing 256-KiB patch-payload and 4-MiB JSONL-record limits.
- Produces:

```ts
export interface AgentPatchHunkEvidence {
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

export interface AgentPatchChange {
  // Existing flattened fields remain authoritative for committed correlation.
  readonly worktreeHunks?: readonly AgentPatchHunkEvidence[];
}
```

- The existing `MAX_PATCH_LINE_FINGERPRINTS = 128` is one source-ordered budget across all `worktreeHunks` of one patch change. It is not 128 per hunk. Existing flattened arrays, ranges, fingerprints, equality/deduplication, and committed tests remain unchanged.

- [ ] **Step 1: Add failing normalization tests.** Cover a two-hunk update whose added lines are separated, an add represented by one synthetic content hunk at new line 1, delete/unknown unsupported sides, malformed hunk headers, payload truncation, 127/128/129 fingerprints across multiple hunks, duplicate linked/durable records, and retained `movedFrom` for committed compatibility.
- [ ] **Step 2: Run adapter tests red.** Run `npm run build && node --test dist/test/codex-history.test.js dist/test/codex-range-projection.test.js`; expect missing `worktreeHunks` assertions while all old flattened assertions remain green.
- [ ] **Step 3: Parse per-hunk material during existing normalization.** Extend `normalizedPayloadLines` to build source-ordered hunk builders from strict unified-diff headers, collect only the operation’s current match side, and synthesize an add/content hunk. Set `truncated: true` for payload truncation, malformed/incomplete hunk structure, declared/observed count disagreement, or exhaustion of the shared fingerprint budget.
- [ ] **Step 4: Preserve flattened committed evidence exactly.** Continue deriving `matchLineFingerprints`, `distinctiveLineFingerprints`, `hunkRanges`, `payloadFingerprint`, `lineCount`, `matchSide`, and `movedFrom` through the current path. Do not make committed `comparePatchChangeToHunks`, deduplication, or durable/linked equivalence consume `worktreeHunks`.
- [ ] **Step 5: Preserve fail-closed relevance coverage.** An otherwise target-relevant change whose worktree hunks cannot be classified adds `unclassified-patch-change`/material summary coverage. Do not drop already valid flattened committed evidence merely because worktree-only hunk projection is incomplete.
- [ ] **Step 6: Run adapter and committed correlation tests.** Run `npm run build && node --test dist/test/codex-history.test.js dist/test/codex-range-projection.test.js dist/test/correlation-decision-table.test.js dist/test/correlation-patch.test.js`.
- [ ] **Step 7: Commit normalized hunk evidence.** Run `git add src/agents test/codex-history.test.ts test/codex-range-projection.test.ts test/correlation-decision-table.test.ts test/correlation-patch.test.ts && git commit -m "feat: retain bounded Codex patch hunks"`.

### Task 5: Add exact-current-worktree projection and the separate worktree decision table

**Files:**
- Create: `src/correlation/score-worktree-candidate.ts`
- Create: `src/correlation/correlate-worktree.ts`
- Modify: `src/provenance/correlate-codex.ts`
- Modify: `src/agents/agent-history-source.ts`
- Modify: `src/agents/codex/source.ts`
- Create: `test/worktree-correlation-decision-table.test.ts`
- Extend: `test/provenance-correlation-flow.test.ts`
- Extend: `test/correlation-e2e.test.ts`

**Interfaces:**
- Consumes: `PreparedCodexEvidence`, `WorktreeCorrelationTarget`, normalized per-hunk patch evidence, and the current repository identity.
- Produces:

```ts
export function scoreWorktreeCandidate(
  target: WorktreeCorrelationTarget,
  input: CorrelationCandidateInput,
): CorrelationCandidate;

export function correlateWorktree(
  target: WorktreeCorrelationTarget,
  inputs: readonly CorrelationCandidateInput[],
  coverage: CorrelationCoverage,
): CorrelationResult;

export async function projectPreparedCodex(
  prepared: PreparedCodexEvidence,
  target: ProvenanceCorrelationTarget,
  location: ResolvedCodeLocation,
): Promise<CorrelationResult>;

export async function verifyPreparedCodexEvidenceStable(
  prepared: PreparedCodexEvidence,
): Promise<void>;
```

- Split the current projection body internally into `projectPreparedCommitCodex` and `projectPreparedWorktreeCodex`. The commit branch retains current reference resolution, aliases, candidate possibility classification, ranking, evidence projection, scorer, and selector exactly.
- Extend `AgentHistorySource` with an optional read-only signature verifier. `CodexHistorySource` implements it with `stat`; worktree selection treats absent verification as material incomplete coverage and a changed known signature as an operational source-mutation failure. Synthetic tests that expect a positive result implement the verifier explicitly.

- [ ] **Step 1: Write the worktree candidate table red.** Build plain worktree targets/evidence and cover exact one-strong -> matched, two-strong -> ambiguous/select none, lone plausible -> none plus one alternative, complete no-match, limited no-match, unavailable discovery, failed/attempt-only patch, timestamp/reference/path-only evidence, one distinctive line, generic material, operation/path/hunk mismatch, target/patch truncation, candidate-specific material limitation, omitted candidate cap, and empty-readable versus unavailable stores.
- [ ] **Step 2: Add exact record-identity tests.** Use real temporary current and linked worktrees plus nested repositories. Assert a nested cwd under the exact current root qualifies only when canonical worktree root, worktree-specific Git dir, common Git dir, and object format all match. Assert linked worktree, same common directory, deleted/historical cwd, nested incompatible repo, unknown cwd, candidate-level current compatibility, and mixed current/linked cwd-less inheritance cannot become strong or plausible; unresolved relevant identity adds material coverage.
- [ ] **Step 3: Add the complete `movedFrom` matrix.** Assert it never adds an alias, never creates rename evidence, never contributes a signal/score, never participates in divergence/supersession, and never permits an old-path match. Assert an otherwise complete ordinary current-path update can qualify after the field is discarded, while an incomplete/old-path-dependent projection contributes no signal plus material coverage when relevant.
- [ ] **Step 4: Run the new decision test red.** Run `npm run build && node --test dist/test/worktree-correlation-decision-table.test.js`; expect missing scorer/correlator/projection behavior.
- [ ] **Step 5: Implement exact-current directory resolution.** Resolve each patch record’s effective cwd with existing `evidenceDirectory` mechanics, then use argv-only `rev-parse --path-format=absolute --show-toplevel`, `--git-dir`, `--git-common-dir`, and `--show-object-format`. Canonicalize existing directories. Cwd-less inheritance is exact only when every structurally possible observed directory is nonempty and resolves to the exact current identity; otherwise retain a limitation, not a positive record.
- [ ] **Step 6: Implement worktree-only summary possibility and projection.** Do not call committed `classifyStrongPossibility`, `resolveReferences`, `targetPathAliases`, or historical-anchor projection for a worktree target. Use only exact current path; discard `movedFrom` before path/operation/locality/chronology; pass empty references; rank projection candidates deterministically without timestamp or commit-reference evidence; retain the existing per-target cap of 32 and existing global coverage counters/limitations.
- [ ] **Step 7: Implement the worktree scorer.** Emit only structurally justified existing signal kinds (`exact-current-worktree`, `structured-patch-target-path`, `structured-patch-overlap`, and `structured-content-divergence`). Assign `strong` only when all ten frozen gates pass. Assign `plausible` only for exact identity + successful supported complete current-path operation with no contradiction but no exact query-local proof. Everything else is weak or coverage-limited; score is only deterministic presentation ordering and cannot bypass a gate.
- [ ] **Step 8: Implement chronology in source-record order.** Compare only complete exact-current-worktree ordinary current-path changes local to the same final region. A later complete local disagreement contradicts an earlier match; a still-later exact match to that region supersedes it; unrelated path/hunk does neither; unresolved/truncated evidence adds limitations; partial final overlap is never strong. Manual divergence never yields human-authorship wording.
- [ ] **Step 9: Implement separate selection and coverage.** Reuse the existing limitation merge/count conventions, but call only `scoreWorktreeCandidate`. Return ambiguous for 2+ strong even under otherwise limited coverage; matched only for exactly one strong with complete sufficient coverage and no material candidate/target limitation; otherwise none with bounded alternatives; preserve unavailable source. Do not add a status.
- [ ] **Step 10: Add closing Codex stability.** Re-discover the namespace and compare every retained non-null source signature through the adapter verifier after projection. A changed namespace/signature during a worktree analysis throws an `OperationalError` for exit 3. A source that cannot provide required positive stability yields material coverage and cannot match; committed-only analysis keeps its current semantics.
- [ ] **Step 11: Run focused projection and all committed regression suites.** Run `npm run build && node --test dist/test/worktree-correlation-decision-table.test.js dist/test/provenance-correlation-flow.test.js dist/test/correlation-e2e.test.js dist/test/correlation-decision-table.test.js dist/test/correlation-patch.test.js`. Existing committed expectations may receive only target-discriminant/identity fixture changes.
- [ ] **Step 12: Commit worktree projection and decisions.** Run `git add src/correlation/score-worktree-candidate.ts src/correlation/correlate-worktree.ts src/provenance/correlate-codex.ts src/agents/agent-history-source.ts src/agents/codex/source.ts test/worktree-correlation-decision-table.test.ts test/provenance-correlation-flow.test.ts test/correlation-e2e.test.ts && git commit -m "feat: correlate exact worktree patch evidence"`.

### Task 6: Integrate single-line worktree analysis, rendering, and closing stability

**Files:**
- Create: `src/provenance/verify-analysis-stability.ts`
- Modify: `src/provenance/explain-location.ts`
- Modify: `src/provenance/model.ts`
- Modify: `src/cli/render-summary.ts`
- Modify: `src/cli/render-text.ts`
- Modify: `src/cli/render-correlation.ts`
- Create: `test/worktree-provenance-flow.test.ts`
- Extend: `test/explanation-render.test.ts`
- Extend: `test/correlation-render.test.ts`
- Extend: `test/git-provenance.test.ts`

**Interfaces:**
- Consumes: one resolved `CurrentSourceSnapshot`, baseline blame/provenance, one `WorktreeTargetConstruction`, prepared/projected Codex evidence, and optional existing analysis hooks.
- Produces:

```ts
export interface WorktreeStabilityExpectation {
  readonly queriedLines: readonly number[];
  readonly evidenceDigest: string;
}

export async function verifyAnalysisStability(input: {
  readonly runner: GitRunner;
  readonly repository: RepositoryContext;
  readonly location: ResolvedCodeLocation | ResolvedRangeCodeLocation;
  readonly worktree?: readonly WorktreeStabilityExpectation[];
  readonly preparedCodex?: PreparedCodexEvidence;
}): Promise<void>;
```

- `analyzeLocation` keeps the existing committed branch unchanged. For an untracked or zero-object blame line, it inspects the exact line, skips ancestry, projects Codex only for `ready`, and records `insufficient`/`unavailable`/`work-bound` without manufacturing a `CorrelationResult`.

- [ ] **Step 1: Write single-line flow tests first.** Cover positive tracked modification, staged add, untracked add, intent-to-add, partial staging/final content, insufficient local material, work-bound file/hunk, target unavailable, ambiguous Codex evidence, plausible-only evidence, complete no-match, source unavailable, and ancestry not run. Replace only the now-obsolete “uncommitted returns before discovery” expectations; retain a no-discovery assertion for insufficient/unavailable/work-bound constructions.
- [ ] **Step 2: Add the unchanged-dirty regression test.** Analyze an unchanged line in a dirty file with the same fixture before/after the new code and assert committed provenance, ancestry, correlation target/result, Codex scan count, and summary/details are regression-equivalent. The mere dirty state must not call `inspectWorktreeChange` for that line.
- [ ] **Step 3: Add stability failures before implementation.** Through `beforeFinalVerification`, mutate file content, replace the file/inode, change HEAD, switch branch/detached state, replace the selected worktree/repository identity, change target hunk/fingerprint evidence while preserving superficial dirty state, and mutate Codex namespace/source. Every case must reject with exit 3. Add an index-only stage/unstage case with identical HEAD/current content and evidence digest that remains successful.
- [ ] **Step 4: Refactor existing closing checks into `verifyAnalysisStability`.** Preserve current HEAD, branch, `FileSnapshot`, and `readTargetStatus` checks. For a worktree report, rediscover and compare canonical root, worktree-specific Git dir, common Git dir, and object format; resolve the same regular file/path; rerun `inspectWorktreeChange` over the retained queried lines; and compare change kind, hunk coordinates, completeness, fingerprints, and evidence digest while ignoring staging-only differences.
- [ ] **Step 5: Integrate one-read single-line orchestration.** Have `analyzeLocation` call `resolveCurrentSource` once and `resolvedCodeLocationFromSource`; retain the source only invocation-locally for inspection. Keep committed ancestry and `correlateCodex` scheduling unchanged. For ready worktree targets, call `prepareCodexEvidence` once, project once, and pass the prepared snapshot to closing stability validation.
- [ ] **Step 6: Add fixed worktree rendering.** Render textual last-touch as uncommitted plus `modified against HEAD <7>` or current path absent/untracked wording, ancestry as “not run for an uncommitted line,” and the frozen positive/ambiguous/plausible/complete-negative/unavailable/insufficient/work-bound phrases. Use a target-aware worktree correlation renderer rather than changing the existing committed summary strings.
- [ ] **Step 7: Add details and privacy assertions.** Details may show full HEAD, current target path, modified/added, staging diagnostic, bounded hunk coordinates, proof counts, sanitized session ID, coverage, and limitations. Assert no fingerprint, raw diff/patch, transcript path, absolute cwd, prompt, reasoning, command/output, tests, old path, `movedFrom`, rename/move/copy, authorship, causation, or origin wording.
- [ ] **Step 8: Run focused single-line/render/stability suites.** Run `npm run build && node --test dist/test/worktree-provenance-flow.test.js dist/test/explanation-render.test.js dist/test/correlation-render.test.js dist/test/git-provenance.test.js dist/test/provenance-correlation-flow.test.js`.
- [ ] **Step 9: Commit single-line integration.** Run `git add src/provenance/verify-analysis-stability.ts src/provenance/explain-location.ts src/provenance/model.ts src/cli/render-summary.ts src/cli/render-text.ts src/cli/render-correlation.ts test/worktree-provenance-flow.test.ts test/explanation-render.test.ts test/correlation-render.test.ts test/git-provenance.test.ts test/provenance-correlation-flow.test.ts && git commit -m "feat: explain uncommitted worktree lines"`.

### Task 7: Add line-specific range groups and inherit them through symbols

**Files:**
- Modify: `src/provenance/range-model.ts`
- Modify: `src/provenance/explain-range.ts`
- Modify: `src/cli/render-range-summary.ts`
- Modify: `src/cli/render-range-details.ts`
- Create: `test/worktree-range-provenance.test.ts`
- Extend: `test/range-grouping.test.ts`
- Extend: `test/range-provenance-flow.test.ts`
- Extend: `test/range-render.test.ts`
- Extend: `test/symbol-provenance.test.ts`
- Extend: `test/symbol-render.test.ts`

**Interfaces:**
- Consumes: existing `RangeTextualGroup[]`, per-line blame facts, committed target builder, one invocation-level worktree inspection over only uncommitted query lines, and one optional `PreparedCodexEvidence`.
- Produces:

```ts
export type CorrelationAnalysisGroup =
  | {
      readonly kind: "commit";
      readonly analysisGroupId: string;
      readonly textualGroupId: string;
      readonly spans: readonly RangeLineSpan[];
      readonly target: CommitCorrelationTarget;
    }
  | {
      readonly kind: "worktree";
      readonly analysisGroupId: string;
      readonly textualGroupId: string;
      readonly spans: readonly RangeLineSpan[];
      readonly construction: WorktreeTargetConstruction;
    };
```

- A committed group remains one analysis group. Worktree groups split by current path/change identity, target hunk, added run, contiguous queried run, and at most 32 proof lines. `RangeCorrelationGroup` maps back with `textualGroupId`; renderers iterate correlation groups in source order rather than assuming one correlation result per textual group.

- [ ] **Step 1: Write second-layer grouping tests red.** Feed one all-zero textual group spanning two unrelated hunks, separated added runs, and an insufficient line. Assert distinct source-ordered analysis IDs/spans and no merge by zero object ID. Assert committed textual grouping itself remains unchanged.
- [ ] **Step 2: Add range behavior cases.** Cover committed + ready worktree + insufficient worktree in one range; multiple worktree hunks; one exact proof covering several queried lines; no result outside its exact covered spans; work-bound file/hunk; unavailable target; uncommitted ancestry always not-run; and no declaration/range-wide promotion.
- [ ] **Step 3: Add the shared 24/25 boundary.** Construct interleaved committed and ready-worktree groups ordered by first source line. Assert only the first 24 consume deep projection, group 25 is `work-bound/group-limit`, no 24+24 split exists, and insufficient/unavailable constructions render but consume no Codex slot. Assert one discovery/summary scan per transcript for the entire mixed invocation and independent projections from the prepared evidence.
- [ ] **Step 4: Run range tests red.** Run `npm run build && node --test dist/test/range-grouping.test.js dist/test/range-provenance-flow.test.js dist/test/worktree-range-provenance.test.js`; expect missing analysis-group behavior.
- [ ] **Step 5: Build analysis groups after baseline blame and commit inspection.** Preserve `groupTextualAttributions` and `inspectRangeFacts`. Build commit targets as today. Pass only uncommitted query lines to one `inspectWorktreeChange`, map each construction back to its textual group, sort all commit/ready worktree groups by first queried line, and apply one `MAX_DEEP_GROUPS = 24` ordinal.
- [ ] **Step 6: Prepare and project Codex once.** Call `prepareCodexEvidence` only when at least one selected commit or ready-worktree group needs projection. Project each selected target from that prepared snapshot under the existing per-target 32-session cap. Do not reopen raw transcript history. Insufficient/unavailable/work-bound target envelopes never become `CorrelationResult.none`.
- [ ] **Step 7: Keep ancestry and coverage line-specific.** Run existing committed ancestry only for selected committed groups. Every uncommitted span remains `not-run`. Store worktree results only on their construction spans. Update coverage counters to distinguish textual committed/uncommitted groups, total deep analysis groups, ready worktree groups, and group-limit omissions without exposing fingerprints.
- [ ] **Step 8: Update range/details rendering.** Render every correlation analysis group under its exact span, including mixed committed/worktree, insufficient, unavailable, and work-bound outcomes. Keep textual facts and ancestry grouped as today. Add only bounded current-path/HEAD/staging/hunk/proof details and the frozen privacy sentence.
- [ ] **Step 9: Prove symbol equivalence.** For the same one-read source snapshot, compare `analyzeSymbol(selector, file)` with `analyzeResolvedRange` over the resolver’s exact span. Assert identical textual facts, analysis groups, worktree correlations, coverage, and stability outcomes; a matching line cannot promote evidence to the rest of the declaration. Keep the 201-line symbol rejection before provenance work.
- [ ] **Step 10: Run all range and symbol suites.** Run `npm run build && node --test dist/test/range-*.test.js dist/test/worktree-range-provenance.test.js dist/test/symbol-*.test.js`.
- [ ] **Step 11: Commit range/symbol integration.** Run `git add src/provenance/range-model.ts src/provenance/explain-range.ts src/cli/render-range-summary.ts src/cli/render-range-details.ts test/range-grouping.test.ts test/range-provenance-flow.test.ts test/range-render.test.ts test/worktree-range-provenance.test.ts test/symbol-provenance.test.ts test/symbol-render.test.ts && git commit -m "feat: correlate mixed worktree ranges"`.

### Task 8: Complete the frozen acceptance matrix and publish the implementation PR

**Files:**
- Create: `test/worktree-acceptance.test.ts`
- Extend where a direct unit seam is the stronger assertion: `test/worktree-change-git.test.ts`
- Extend where a direct unit seam is the stronger assertion: `test/worktree-correlation-decision-table.test.ts`
- Extend: `test/symbol-acceptance.test.ts`
- Extend: `test/cli.test.ts` only for regression confirmation; no new CLI syntax

**Interfaces:**
- Consumes: compiled `dist/src/cli/main.js`, disposable real Git repositories/worktrees, local synthetic Codex JSONL under fixture-controlled `CODEX_HOME`, and the public summary/details output.
- Produces: one finite end-to-end acceptance suite proving the normative design and a clean, reviewable implementation branch ready for a PR.

- [ ] **Step 1: Build the disposable acceptance fixtures.** Create real repositories for tracked modification, staged add, untracked add, intent-to-add, partially staged final content, unchanged dirty line, mixed committed/worktree range, multiple hunks, symbol range, linked worktree, bounds, and mutation hooks. Generate only structured local patch-result transcripts with explicit effective cwd; never use prompts/commands/output as fixtures for positive evidence.
- [ ] **Step 2: Add positive and outcome assertions.** Cover tracked update, staged/untracked/intent-to-add add, partially staged final content, one strong -> matched, 2+ strong -> ambiguous, lone plausible -> none plus alternative, complete no-match, limited no-match, unavailable history, exact query-local whole-file add, and added-file later update.
- [ ] **Step 3: Add every negative evidence assertion.** Cover repository mismatch; linked/same-common/deleted/unknown/nested-incompatible cwd; operation/path/hunk mismatch; query not covered; one distinctive line; fewer than 40 alphanumerics; boilerplate/generic/repeated alignment; target and patch truncation; patch attempt/failed result; timestamps/references/path-only material; and all five `movedFrom` guarantees including independently qualifying current-path evidence and old-path-dependent failure.
- [ ] **Step 4: Add chronology/source assertions.** Cover A matching, later B disagreeing, still-later exact supersession, unrelated path/hunk, manual final edit, partial final overlap, compaction, rollback, abort, corruption, partial record, source omission/candidate cap, empty readable store, unavailable store, and Codex namespace/file mutation.
- [ ] **Step 5: Add locality/bounds/stability assertions.** Cover unchanged dirty line, context/deleted lines, adjacent/multiple hunks, file-start insertion, line shifts, 200-line query limit, 24/25 shared group boundary, 2-MiB current/HEAD material, 256-line/32-KiB/128-fingerprint target bounds, 256-KiB patch, 4-MiB record, 32 proof lines, file content mutation/replacement, HEAD/branch/repository identity/evidence-digest mutation, and harmless index-only staging change.
- [ ] **Step 6: Add rendering/privacy/compatibility assertions.** Exercise summary and details for positive tracked/untracked, ambiguous, plausible, complete negative, unavailable source, insufficient target, work-bound target, unchanged dirty line, mixed range, and symbol. Assert only the frozen claim family, no create/rename/move/copy/authorship/causation/origin wording, no private/raw fields, unchanged CLI syntax and exit codes, and unchanged committed exact/transformed ancestry behavior.
- [ ] **Step 7: Run the focused acceptance suites and commit them.** Run `npm run build && node --test dist/test/worktree-acceptance.test.js dist/test/symbol-acceptance.test.js dist/test/worktree-provenance-flow.test.js dist/test/worktree-range-provenance.test.js`, then `git add test/worktree-acceptance.test.ts test/symbol-acceptance.test.ts test/worktree-change-git.test.ts test/worktree-correlation-decision-table.test.ts test/cli.test.ts && git commit -m "test: accept worktree change correlation"`.
- [ ] **Step 8: Run one normal final verification pass.** Run `npm run check`, then `git diff --check`. Do not start an open-ended bug hunt or performance campaign; if a listed acceptance failure exposes one load-bearing defect, apply one bounded correction and rerun only the affected focused test plus this single final check.
- [ ] **Step 9: Perform one bounded frozen-spec diff review.** Inspect only target separation, HEAD/current authority, no rename/alias/`movedFrom` semantics, exact-local proof, exact current worktree, candidate table/coverage, divergence, shared budgets/bounds, one-scan lifecycle, stability, Git argv safety, rendering/privacy, and the committed regression boundary. Stop when the normative matrix passes.
- [ ] **Step 10: Record final repository evidence.** Run `git diff --stat 2c30355b647d72e828868a372bde95da71c84325..HEAD`, `git status --short`, and `git log --oneline --decorate 2c30355b647d72e828868a372bde95da71c84325..HEAD`. The worktree must be clean and every task must be represented by its coherent commit.
- [ ] **Step 11: Publish for review, without merging.** Push the implementation branch with upstream tracking and open the implementation PR. Do not merge it. The stopping condition is the frozen acceptance criteria passing and the PR being available for review; do not add an adapter, `--changed`, worktree ancestry, GitHub context, index provenance, first-parent behavior, fuzzy matching, or rename/move/copy support.

---

## Normative Acceptance Traceability

| Frozen acceptance area | Implemented in | Primary tests |
| --- | --- | --- |
| Target distinction and committed mechanical compatibility | Task 1 | `provenance-correlation-target`, committed decision/patch/e2e suites |
| Tracked modification, staged/untracked/intent-to-add, partial staging, HEAD-absent add | Task 2; accepted Task 8 | `worktree-change-git`, `worktree-acceptance` |
| No old-path discovery, no rename target, safe `--no-renames` Git boundary | Task 2; audited Task 8 | `worktree-change-git`, command recorder in `worktree-acceptance` |
| Unchanged dirty line, baseline blame, line shifts, context/deleted locality | Tasks 2 and 6 | `git-provenance`, `git-blame-range`, `worktree-provenance-flow` |
| Unmerged, missing object, binary/invalid historical material, unsupported/incomplete shape | Task 2 | `worktree-change-git` |
| Exact update/add/later-update overlap, unique alignment, every query line, 2/40/32 floor | Task 3 | `worktree-overlap` |
| Operation/path/hunk mismatch, repetition, boilerplate, one line, truncation | Tasks 3 and 5 | `worktree-overlap`, `worktree-correlation-decision-table` |
| Per-hunk normalized patch material and shared 128 cap | Task 4 | `codex-history`, `codex-range-projection` |
| `movedFrom` never supplies worktree semantics; ordinary current-path evidence stands alone | Task 5; accepted Task 8 | `worktree-correlation-decision-table`, `worktree-acceptance` |
| Exact current nested cwd; linked/common/deleted/unknown/incompatible exclusion | Task 5 | `worktree-correlation-decision-table`, `provenance-correlation-flow` |
| 1 strong, 2+ strong, plausible, complete/limited none, unavailable | Task 5 | `worktree-correlation-decision-table` |
| Non-qualifying prompts/timestamps/commands/output/tests/references/attempts/path-only evidence | Task 5; rendered Task 6 | `worktree-correlation-decision-table`, privacy assertions |
| Divergence, supersession, unrelated hunk, manual/partial final edits | Task 5 | `worktree-correlation-decision-table`, `worktree-acceptance` |
| Compaction/corruption/omission, 32 cap, empty versus unavailable source | Task 5 | `correlation-e2e`, `worktree-correlation-decision-table` |
| Single-line positive/uncertain/unavailable/Git-only reports and mutation exit 3 | Task 6 | `worktree-provenance-flow`, renderer suites |
| Mixed range, multiple hunks, insufficient/work-bound spans, no promotion | Task 7 | `worktree-range-provenance`, range suites |
| One shared 24-group budget and one Codex preparation lifecycle | Task 7 | `worktree-range-provenance` 24/25 and scan-count cases |
| Symbol equals explicit resolved range, 200-line bound, no declaration promotion | Task 7 | `symbol-provenance`, `symbol-acceptance` |
| 2-MiB files/blobs, 256 lines, 32 KiB, 128 fingerprints, 256-KiB patch, 4-MiB record | Tasks 2–4; accepted Task 8 | Git/adapter unit bounds plus compiled acceptance |
| HEAD/branch/repository/path/file/evidence/Codex stability and index-only harmless change | Tasks 5–6 | `worktree-provenance-flow`, `worktree-acceptance` |
| Privacy and exact explanation-first wording | Tasks 6–8 | explanation/correlation/range/symbol render suites and compiled acceptance |
| Existing CLI, exit codes, committed blame/correlation/ancestry/symbol/privacy behavior | Every task; final Task 8 | existing full suite under `npm run check` |
| Disposable real-Git compiled CLI acceptance | Task 8 | `worktree-acceptance`, `symbol-acceptance` |

## Stopping Condition

The milestone is complete when every row above passes, `npm run check` and `git diff --check` are green, the implementation diff is clean and bounded to this plan, and the implementation PR is published for review. Stop there. Worktree rename/move/copy, old-path discovery, index provenance, new query forms, new agent adapters, GitHub context, worktree ancestry, semantic/fuzzy matching, and broader history search remain out of scope.
