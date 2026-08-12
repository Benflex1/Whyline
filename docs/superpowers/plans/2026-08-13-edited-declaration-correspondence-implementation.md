# Explain Edited Declarations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conservative verified direct-parent declaration correspondence for materially edited TypeScript-family lines while preserving exact ancestry and Codex semantics.

**Architecture:** Extract the existing TypeScript-family AST collection into a reusable in-memory declaration index. Add a pure bounded proof that compares declaration facts, actual diff hunks, and exact preserved anchors. Keep Git loading/path mapping in a focused tracer and overlay transformed coverage only after exact coverage has been established per queried line.

**Tech Stack:** TypeScript 5.9 compiler API, Node.js 24, ESM, built-in `node:test`, existing argv-only `GitRunner`, existing range provenance and renderer modules.

## Global Constraints

- Exact ancestry remains the strongest result and is never relabeled or weakened.
- The only new positive relationship is `status: "transformed", relationship: "direct-parent-declaration"`.
- The frozen syntactic key is declaration kind, exact qualified name, declaration form, and method staticness.
- Only the selected direct parent is used; ambiguous merge parents and roots have no positive correspondence.
- Supported language scope remains the existing TypeScript/JavaScript extension family and syntax resolver behavior.
- Only the same path or one directly observed connected Git rename may map child to parent.
- No fuzzy, normalized, semantic, AST-similarity, embedding, LLM, confidence, history-walk, checkout, mutation, or network behavior is added.
- Positive proof requires a queried added line, direct hunk connectivity, changed declaration text, one unique exact anchor with at least 2 distinctive lines and 40 alphanumeric characters, and complete material.
- Limits are 12 correspondence attempts per invocation, 2 MiB per historical blob, 512 supported declarations per historical blob, 200 lines per participating declaration, 32 anchor lines, and 40,000 exact line-pair checks.
- Existing 24 committed textual groups remain the range deep-analysis bound; omitted groups are `unavailable / work-bound`.
- No historical source excerpts, AST nodes, raw diff payloads, semantic/historical-symbol/origin wording, or Codex behavior changes may enter reports.

---

### Task 1: Add the transformed ancestry and declaration-fact models

**Files:**
- Modify: `src/ancestry/model.ts`
- Modify: `src/provenance/range-model.ts`
- Modify: `src/symbol/model.ts`
- Test: `test/declaration-correspondence-proof.test.ts`

**Interfaces:**
- Add `DeclarationForm = "declaration" | "const-function"`, `DeclarationKey`, `DeclarationFact`, and `DeclarationIndex` to the symbol model. Facts contain only bounded key/span/offset metadata; no AST nodes.
- Add `PreservedAnchorProof`, `DeclarationHunkProof`, and `TransformedDeclarationEvidence` to ancestry model.
- Extend `GitAncestryStatus` and `GitAncestryResult` with a transformed variant carrying textual commit, parent commit, paths, declaration spans, key, selected-parent evidence, hunk proof, anchor proof, and limitations.
- Extend `RangeAncestrySegmentStatus` and segment fields with transformed evidence.

- [ ] **Step 1: Write the proof contract tests before implementation.** Build plain declaration facts and hunk objects, then assert that the future proof accepts a changed target line with one same-key parent declaration and a two-line/40-character exact anchor. Add individual tests for insufficient anchor, two matching alignments, disconnected hunk, duplicate parent facts, changed qualified name/kind/form/staticness, insertion-only connectivity, identical texts, incomplete material, 201-line declarations, comparison work over 40,000, and exact-line exclusion.
- [ ] **Step 2: Run the new proof test red.** Run `npm run build && node --test dist/test/declaration-correspondence-proof.test.js`; the expected failure is the missing proof module/type, not an unrelated compiler error.
- [ ] **Step 3: Add the smallest discriminated model types.** Keep exact/uncertain/none/unavailable variants structurally unchanged. Use explicit transformed fields rather than optional exact fields, and use `parentSelectionEvidence: "blame-previous" | "sole-parent"` rather than importing a full repository parent object into ancestry evidence.
- [ ] **Step 4: Run the focused test again.** Run `npm run build && node --test dist/test/declaration-correspondence-proof.test.js`; it should still fail because the pure function has not been implemented.
- [ ] **Step 5: Commit the model contract.** Run `git add src/ancestry/model.ts src/provenance/range-model.ts src/symbol/model.ts test/declaration-correspondence-proof.test.ts && git commit -m "feat: model transformed declaration ancestry"`.

### Task 2: Implement the pure bounded declaration correspondence proof

**Files:**
- Create: `src/ancestry/declaration-correspondence-proof.ts`
- Modify: `test/declaration-correspondence-proof.test.ts`

**Interfaces:**
- Export `proveDeclarationCorrespondence(input: DeclarationCorrespondenceProofInput): DeclarationCorrespondenceProofResult`.
- The input contains child/parent lines and complete flags, child/parent declaration facts, the queried child line, parsed `GitHunk` facts, and `exactEstablished: boolean`.
- The result is `transformed` with child/parent facts, hunk proof, and anchor proof; `uncertain` for complete but unproven relationships; or `unavailable` for incomplete/explicit work-bound material.

- [ ] **Step 1: Implement exact-line-kind and hunk-coordinate helpers.** Derive each hunk’s new-side line kind from `newStart` and its `GitDiffLine` sequence. Require the queried child line to be `added`; require child-span overlap with the hunk new range; require old-span overlap with the parent declaration or, only when `oldLines === 0`, an `oldStart` insertion point inside the parent span.
- [ ] **Step 2: Implement innermost child selection.** Filter facts whose inclusive span contains the queried line, sort by smallest span then source order, and return uncertain unless exactly one smallest fact remains. Never use a name-only fallback.
- [ ] **Step 3: Implement frozen-key parent matching.** Compare kind, exact qualified name, declaration form, and staticness with strict equality. Return uncertain for no match or more than one match; do not normalize names, suffixes, case, whitespace, or syntax.
- [ ] **Step 4: Implement exact declaration-text and size gates.** Slice the supplied source text using fact offsets, reject byte-identical strings as non-transformed, reject any participating span over 200 lines, and reject incomplete child/parent material before positive work.
- [ ] **Step 5: Implement the anchor search with a hard comparison counter.** Check every child/parent line pair at most once, aborting as unavailable/work-bound before crossing 40,000 checks. Collapse each maximal diagonal exact run to one alignment identity, cap reported matched lines at 32, count unique `isDistinctiveLine` lines and Unicode alphanumerics, and accept exactly one qualifying alignment. Multiple qualifying alignments are uncertain/ambiguous; no score or positional tie-breaker is permitted.
- [ ] **Step 6: Add proof result limitations.** Positive limitations must explicitly say this is direct-parent declaration correspondence and not an exact line ancestor. Non-positive messages must distinguish insufficient/ambiguous evidence from unavailable/work-bound material without claiming absence of history.
- [ ] **Step 7: Run the proof suite green and commit.** Run `npm run build && node --test dist/test/declaration-correspondence-proof.test.js`, then commit `git add src/ancestry/declaration-correspondence-proof.ts test/declaration-correspondence-proof.test.ts && git commit -m "feat: prove bounded declaration correspondence"`.

### Task 3: Extract the reusable in-memory TypeScript declaration index

**Files:**
- Create: `src/symbol/declaration-index.ts`
- Modify: `src/symbol/typescript-resolver.ts`
- Modify: `src/symbol/model.ts`
- Test: `test/symbol-resolver.test.ts`
- Test: `test/symbol-declarations.test.ts`

**Interfaces:**
- Export `parseDeclarationIndex(repositoryPath: string, text: string, options?: { maxDeclarations?: number }): Promise<DeclarationIndex>`.
- The parser consumes only path/text, returns facts with exact offsets/spans/key fields, and throws the same current-worktree `InvalidInputError`/ `OperationalError` categories as the existing resolver.
- Historical callers use `maxDeclarations: 512`; current symbol resolution omits that option to preserve accepted current behavior.

- [ ] **Step 1: Write historical index tests first.** Parse in-memory TS, TSX, JS, JSX, Unicode names, nested declarations, overload groups, duplicate qualified names, and syntax errors. Assert no filesystem reads, no tsconfig/import lookup, no AST in returned facts, and a declaration-cap error at 513 supported declarations.
- [ ] **Step 2: Run index/resolver tests red.** Run `npm run build && node --test dist/test/symbol-resolver.test.js dist/test/symbol-declarations.test.js`; failures should identify the missing exported index or changed resolver seam.
- [ ] **Step 3: Move the existing dialect, compiler-host, syntax-check, candidate collection, overload grouping, and line-boundary logic into the index module.** Preserve all existing supported forms and exclusions exactly. Keep the TypeScript dynamic import lazy and keep the compiler host root-only, no-lib, no-resolve, syntax-only configuration.
- [ ] **Step 4: Preserve current symbol behavior through the index.** Have `resolveTypeScriptSymbol` call the index, map the selected fact to the existing `SymbolResolution`, retain the optional `const-function` declarationForm output, and apply the existing 200-line check and exact ambiguity formatting unchanged.
- [ ] **Step 5: Add the historical declaration cap path.** If more than 512 supported facts are collected, throw a typed bounded-work error that the Git tracer can convert to unavailable/work-bound; do not recover partial facts.
- [ ] **Step 6: Run all symbol tests.** Run `npm run build && node --test dist/test/symbol-*.test.js`; fix only regressions in the existing resolver contract.
- [ ] **Step 7: Commit the refactor.** Run `git add src/symbol test/symbol-resolver.test.ts test/symbol-declarations.test.ts && git commit -m "refactor: share TypeScript declaration facts"`.

### Task 4: Add bounded historical material and direct-parent Git tracing

**Files:**
- Create: `src/git/ancestry-material.ts`
- Create: `src/git/trace-declaration-correspondence.ts`
- Modify: `src/git/trace-line-ancestry.ts`
- Modify: `src/git/trace-range-ancestry.ts`
- Test: `test/declaration-ancestry-git.test.ts`
- Extend: `test/git-ancestry.test.ts`

**Interfaces:**
- `loadAncestryBlob(runner, context, commitId, path, options): Promise<{ material } | { failure } | { absent }>` uses argv-only `ls-tree -z --full-tree <commit> -- <path>` and `cat-file blob <object>`, rejects NUL/invalid UTF-8, and enforces an optional 2 MiB limit before parsing.
- `traceDeclarationCorrespondence(runner, context, location, provenance, cache?): Promise<GitAncestryResult | null>` uses the existing selected parent and existing changed-path/hunk facts. `null` means ineligible/no candidate and lets existing ancestry status remain unchanged; typed unavailable/uncertain results are returned after a bounded eligible attempt.
- `DeclarationCorrespondenceTraceCache` stores blob/index promises and a source-ordered set/map of up to 12 declaration-pair attempt identities.

- [ ] **Step 1: Write real-Git tests before the tracer.** Cover same-file edit, connected Git rename plus edit, exact precedence, root, ambiguous parent, shallow/missing object, binary, invalid UTF-8, historical syntax error, 2 MiB blob, leading-dash/unusual paths, and recording that all Git calls remain argv-only read-only commands.
- [ ] **Step 2: Run the Git tests red.** Run `npm run build && node --test dist/test/declaration-ancestry-git.test.js dist/test/git-ancestry.test.js`; the new transformed assertions should fail while old exact tests remain passing.
- [ ] **Step 3: Extract only reusable blob parsing/material loading.** Preserve existing exact invocation arguments and failure mapping. Use the size-limited option only for transformed tracing, treating an observed absent parent path as complete no-candidate evidence rather than missing history.
- [ ] **Step 4: Implement path mapping.** Select the child path from the committed attribution. Accept it unchanged, or map one changed-path rename where `oldPath` is the parent path and `newPath` is the child path. Reject all basename/tree/repository searches and unsupported path extensions.
- [ ] **Step 5: Implement the tracer eligibility gates.** Require committed attribution, a commit parent selection of kind `commit`, a supported child and parent dialect, complete bounded blobs, and the actual selected parent. Do not call the tracer for roots or ambiguous parents.
- [ ] **Step 6: Parse both historical blobs through `parseDeclarationIndex(..., { maxDeclarations: 512 })`.** Convert historical syntax/cap/material failures to unavailable/unsupported limitations. Build one pure proof input per unique declaration pair and pass only existing relevant hunks.
- [ ] **Step 7: Implement the 12-attempt cache.** Count identities in source order; on the thirteenth unique declaration pair return unavailable/work-bound for that queried line. Reuse completed proof results for other lines in the same pair. Do not allow transformed evidence to overwrite exact.
- [ ] **Step 8: Integrate single-line precedence.** In `traceLineAncestry`, keep the existing exact function body and return immediately for `status === "exact"`; otherwise invoke the new tracer and return its non-null result, preserving the old result for null/ineligible cases.
- [ ] **Step 9: Integrate range overlay after exact runs.** In `traceRangeGroupAncestry`, leave current movement/exact candidate generation unchanged, then process sorted queried facts whose outcome is not exact. Apply only per-line transformed outcomes; leave same-declaration non-qualifying lines at their conservative existing status.
- [ ] **Step 10: Run focused and existing ancestry suites, then commit.** Run `npm run build && node --test dist/test/declaration-ancestry-git.test.js dist/test/git-ancestry.test.js dist/test/range-ancestry.test.js`, then commit `git add src/git src/ancestry src/provenance/range-model.ts test/declaration-ancestry-git.test.ts test/git-ancestry.test.ts test/range-ancestry.test.ts && git commit -m "feat: trace direct-parent declaration correspondence"`.

### Task 5: Make range attempt identity and transformed coverage explicit

**Files:**
- Modify: `src/git/trace-range-ancestry.ts`
- Modify: `src/provenance/explain-range.ts`
- Modify: `src/provenance/range-model.ts`
- Test: `test/range-ancestry.test.ts`
- Test: `test/range-provenance-flow.test.ts`

**Interfaces:**
- The shared range cache owns the invocation-local 12-attempt budget and is passed to every deep group in source order.
- `RangeAncestrySegment.status === "transformed"` carries the same bounded transformed evidence as a single-line result.

- [ ] **Step 1: Add failing range tests** for exact/transformed mixtures, transformed/uncertain mixtures, per-line promotion only, exact precedence, cache reuse, repeated attempt identity, the 12-attempt limit, the existing 24-group limit, and work-bound not becoming none.
- [ ] **Step 2: Run range tests red** with `npm run build && node --test dist/test/range-ancestry.test.js dist/test/range-provenance-flow.test.js`.
- [ ] **Step 3: Thread the shared cache through the new tracer without changing range grouping, Codex preparation, correlation projection, or final stability verification.**
- [ ] **Step 4: Partition coverage by line.** Segment adjacent lines only when status and bounded evidence are equal. Keep exact segments exact even if their declaration also proves transformed elsewhere. Mark omitted attempts unavailable/work-bound, never uncertain/none.
- [ ] **Step 5: Assert Codex independence.** Add a range test with a transformed segment and empty/none Codex projection, verifying the Codex status and coverage are byte-for-byte the existing result.
- [ ] **Step 6: Run all range tests and commit.** Run `npm run build && node --test dist/test/range-*.test.js`, then `git add src/git/trace-range-ancestry.ts src/provenance/explain-range.ts src/provenance/range-model.ts test/range-ancestry.test.ts test/range-provenance-flow.test.ts && git commit -m "feat: preserve per-line transformed range coverage"`.

### Task 6: Update single-line/range/symbol rendering without leakage

**Files:**
- Modify: `src/cli/render-summary.ts`
- Modify: `src/cli/render-text.ts`
- Modify: `src/cli/render-range-summary.ts`
- Modify: `src/cli/render-range-details.ts`
- Extend: `test/explanation-render.test.ts`
- Extend: `test/range-render.test.ts`
- Extend: `test/symbol-render.test.ts`

- [ ] **Step 1: Write failing renderer assertions.** Verify single-line summary/details and range summary/details show `Git ancestry`, transformed status, parent/child declaration spans, key fields, selected-parent evidence, hunk relationship, anchor counts, and the explicit non-exact limitation.
- [ ] **Step 2: Assert prohibited wording and privacy.** Test that transformed output never says exact predecessor, exact ancestry, origin, originated, same historical symbol, semantic equivalence, authorship, move, or copy; never prints source excerpts, ASTs, raw hunks, private paths, prompts, or transcript evidence.
- [ ] **Step 3: Implement transformed branches only.** Keep exact branch strings and fields unchanged except for the already-required general ancestry heading. Use bounded sanitized IDs/paths/strings and no dynamic historical text.
- [ ] **Step 4: Render mixed range segments visibly.** Change the summary label from `Exact ancestry` to `Git ancestry`, render exact and transformed with distinct text, and keep uncertain/none/unavailable/not-run/work-bound distinct.
- [ ] **Step 5: Run render tests and commit.** Run `npm run build && node --test dist/test/explanation-render.test.js dist/test/range-render.test.js dist/test/symbol-render.test.js`, then `git add src/cli test/explanation-render.test.ts test/range-render.test.ts test/symbol-render.test.ts && git commit -m "feat: render transformed Git ancestry"`.

### Task 7: Add end-to-end and compiled CLI acceptance coverage

**Files:**
- Extend: `test/ancestry-integration.test.ts`
- Extend: `test/ancestry-acceptance.test.ts`
- Extend: `test/symbol-provenance.test.ts`
- Extend: `test/symbol-acceptance.test.ts`
- Extend: Codex independence tests where necessary

- [ ] **Step 1: Write the disposable fixture first.** Create a real Git repository with one TypeScript symbol/range containing an exact moved block, a changed line in the same declaration with a strong preserved anchor, an edited same-key declaration with insufficient anchor, an uncommitted line, and no Codex history.
- [ ] **Step 2: Run the compiled acceptance test red.** Run `npm run build && node --test dist/test/symbol-acceptance.test.js`; assert the transformed expectation fails before implementation is complete.
- [ ] **Step 3: Add acceptance assertions.** Verify exact remains exact, qualifying changed lines are transformed, insufficient proof is not transformed, dirty lines are not-run, range coverage is line-specific, Codex is independent, root/ambiguous/shallow cases remain conservative, and no historical-symbol/origin wording appears.
- [ ] **Step 4: Add operational and security assertions.** Verify Git failures preserve exit 3, malformed input remains exit 2, unusual/leading-dash paths remain safe, historical blobs are never checked out, and no network/mutation commands are attempted.
- [ ] **Step 5: Run the focused integration/acceptance tests.** Run `npm run build && node --test dist/test/ancestry-integration.test.js dist/test/ancestry-acceptance.test.js dist/test/symbol-provenance.test.js dist/test/symbol-acceptance.test.js`; commit the fixture and assertions with `git add test && git commit -m "test: accept edited declaration correspondence"`.

### Task 8: One normal final verification and bounded diff review

- [ ] **Step 1: Read the implementation plan and create a requirement checklist** covering model, precedence, frozen key, child/parent uniqueness, hunk, anchor, path, work limits, range/single-line/symbol behavior, exact invariants, Codex invariants, privacy, and read-only/offline behavior.
- [ ] **Step 2: Run exactly one normal full pass.** Run `npm run check`, then `git diff --check`. Do not rerun a compiled acceptance test separately if it is already included by `npm run check`.
- [ ] **Step 3: Perform one bounded final diff review only over the listed surfaces.** Inspect transformed model, exact precedence, proof gates, declaration-key equality, hunk connectivity, anchor uniqueness, 12 attempts, all frozen limits, path mapping, safe Git argv, renderer wording/privacy, exact behavior, and Codex behavior. Apply at most one normal correction wave if this review finds a load-bearing violation.
- [ ] **Step 4: Verify repository handoff.** Run `git log --oneline --decorate -12`, `git diff --stat 3c9cdf53030dd8c25f9b4a74bb42cfb33a37fe96..HEAD`, and `git status --short`; confirm no push, PR, merge, or main-branch implementation occurred.
