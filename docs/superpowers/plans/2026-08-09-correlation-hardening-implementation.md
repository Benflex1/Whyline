# Correlation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the frozen correlation-hardening milestone while preserving the existing conservative scorer and fail-closed causal invariant.

**Architecture:** Add an agent-neutral one-pass summary/relevance artifact, make Codex scan and rich projection consume that artifact without reopening stable transcripts, then stage bounded scan, Git, and projection work behind invocation-local memoization. Classify every ref as incompatible, proven-not-strong, or cannot-prove before applying the unchanged pure scorer and coverage-gated selection.

**Tech Stack:** Strict TypeScript/ESM, Node.js 24, Node built-in test runner, argv-only read-only Git subprocesses, synthetic repository/transcript fixtures.

## Global Constraints

- Prefer no causal answer over a false causal answer.
- Keep the two-distinctive-line overlap floor and successful supported structured patch requirement for `strong`.
- Keep the 32 potentially-strong rich-projection cap material.
- Keep fail-closed file and discovery-namespace `changed-during-read` semantics.
- Keep repository mismatch, stale session-head, ambiguity, privacy, Git read-only, and no-network semantics unchanged.
- Do not add snapshot semantics, persistent indexes/caches, semantic ancestry, extra negative proofs, or another milestone.
- All transcript-derived state is invocation-local; telemetry is fixed numeric aggregates only.

---

### Task 1: Agent-neutral typed scan and coverage contracts

**Files:**
- Modify: `src/agents/agent-history-source.ts`
- Modify: `src/correlation/model.ts`
- Test: `test/codex-history.test.ts`
- Test: `test/correlation-decision-table.test.ts`

**Interfaces:**
- Produces `AgentSourceSignature`, `AgentRelevanceCoverageReason`, `AgentRelevanceCoverage`, `AgentCorrelationEvidenceProjection`, `AgentSummaryRelevanceScan`, `CandidateStrongPossibility`, and widened `CorrelationCoverage`.
- `AgentHistorySource.scanSummaryAndRelevance(ref, target?)` becomes the authoritative staged operation; old methods remain only as compatibility seams.

- [ ] **Step 1: Add failing type/coverage tests** for complete versus limited relevance coverage, the closed proof unions, and the replacement coverage field names.
- [ ] **Step 2: Run the focused tests** with `npm test`; confirm failures identify missing scan/proof contracts.
- [ ] **Step 3: Add the readonly contracts** with exhaustive closed unions and no raw transcript fields in the scan artifact.
- [ ] **Step 4: Update existing fixtures and test helpers** to construct the widened coverage shape without changing decision outcomes.
- [ ] **Step 5: Run `npm run typecheck` and the focused test files** and confirm green.

### Task 2: One-pass Codex scan and stable source accounting

**Files:**
- Modify: `src/agents/codex/parse-transcript.ts`
- Modify: `src/agents/codex/extract-evidence.ts`
- Modify: `src/agents/codex/source.ts`
- Modify: `src/agents/codex/discover.ts`
- Modify: `src/agents/codex/index.ts`
- Test: `test/codex-history.test.ts`
- Test: `test/fixtures/codex/README.md`

**Interfaces:**
- Produces one stable `AgentSummaryRelevanceScan` per ref, including byte count, source signature, normalized correlation evidence, and relevance coverage.
- Rich projection consumes the normalized artifact; the Codex correlation path never calls `readSummary`, `extractEvidence`, or rereads a stable transcript.

- [ ] **Step 1: Add failing fixture tests** for one-pass extraction, byte/signature accounting, known closed irrelevant records, relevance-bearing unknown records, mutation, partial/corrupt/compaction/rollback/abort diagnostics, and zero rereads.
- [ ] **Step 2: Run the focused Codex tests** and verify the new tests fail for the missing method/reuse behavior.
- [ ] **Step 3: Fold the evidence collector into the streaming parser visitor** so metadata, effective cwd chronology, patch linkage/results, normalized paths, fingerprints, ranges, and commit references are reduced during the single pass.
- [ ] **Step 4: Track nanosecond source signatures before/after reading, bytes, records, and typed relevance coverage**; preserve known closed non-relevance shapes as non-material while failing closed for unknown relevance-bearing shapes.
- [ ] **Step 5: Add invocation-local complete-scan reuse in `CodexHistorySource`** keyed by adapter ID plus stable signature, with signature revalidation before reuse; retain compatibility wrappers that delegate to the scan.
- [ ] **Step 6: Add discovery namespace signatures** over active/archived membership and file identity/readability for opening and closing comparisons.
- [ ] **Step 7: Run the full Codex test file, typecheck, and build.**

### Task 3: Bounded correlation work primitives

**Files:**
- Create: `src/provenance/bounded-work-pool.ts`
- Create: `src/provenance/correlation-telemetry.ts`
- Modify: `src/git/git-process.ts`
- Test: `test/provenance-correlation-flow.test.ts`

**Interfaces:**
- Produces small correlation-internal bounded pool/gate utilities with injectable limits, deterministic ordinal result slots, cancellation for fatal scheduler failures, and queue/work timing hooks.
- Git process execution remains argv-only/read-only and all classification/reference/projection Git work passes through one shared gate.

- [ ] **Step 1: Add failing tests** for worker limit 1, default derived limits, adversarial completion reordering, bounded Git process count, expected per-ref failure continuation, and fatal scheduler/process-boundary abort.
- [ ] **Step 2: Run the focused flow tests** and verify the scheduler tests fail before implementation.
- [ ] **Step 3: Implement the minimal ordinal bounded pool and shared Git gate**; keep scanning, Git, and projection domains separate and avoid a generic task framework.
- [ ] **Step 4: Add process-boundary timing/count instrumentation** without changing the allowed Git command family or introducing network access.
- [ ] **Step 5: Run focused scheduler tests, typecheck, and build.**

### Task 4: Invocation-local Git memoization and proof classification

**Files:**
- Modify: `src/provenance/correlate-codex.ts`
- Modify: `src/provenance/resolve-commit-reference.ts`
- Modify: `src/git/repository-context.ts`
- Modify: `src/git/git-path.ts`
- Modify: `src/correlation/build-candidates.ts`
- Test: `test/provenance-correlation-flow.test.ts`
- Test: `test/correlation-decision-table.test.ts`

**Interfaces:**
- Produces invocation-local historical-directory and commit-reference memoization/coalescing, safe current/listed-worktree path classification, and exact `CandidateStrongPossibility` classification.
- Only `repository-incompatible`, `no-successful-supported-patch`, and `successful-supported-patch-paths-disjoint` can remove a ref from the potentially-strong set.

- [ ] **Step 1: Add failing proof-boundary and memoization tests** for no-patch proof, path-disjoint proof including rename aliases/moved paths, every cannot-prove boundary, known incompatible versus unknown repository, cache reuse/coalescing, and failed lookup retention as unknown.
- [ ] **Step 2: Run the focused decision/flow tests** and verify the new tests fail while existing scorer rows remain green.
- [ ] **Step 3: Refactor correlation orchestration** to scan all refs once, classify with bounded Git work, memoize identical lookups, and preserve deterministic ordinal ordering.
- [ ] **Step 4: Implement exhaustive proof classification** from normalized scan facts and safe target aliases; never use session-head, time, branch, relationship, basename, source ordering, partial state, unknown paths/repos, or incomplete coverage as negative proof.
- [ ] **Step 5: Run decision-table, flow, typecheck, and build checks.**

### Task 5: Coverage/scoring integration and telemetry privacy

**Files:**
- Modify: `src/correlation/correlate.ts`
- Modify: `src/correlation/model.ts`
- Modify: `src/provenance/model.ts`
- Modify: `src/cli/render-correlation.ts`
- Modify: `src/provenance/correlate-codex.ts`
- Modify: `src/provenance/explain-location.ts`
- Test: `test/correlation-decision-table.test.ts`
- Test: `test/correlation-e2e.test.ts`
- Test: `test/provenance-correlation-flow.test.ts`

**Interfaces:**
- Produces complete/limited/unavailable coverage counts for discovered, usable, incompatible, proven-not-strong, potentially-strong, projected, and omitted refs.
- Produces an explicit diagnostic numeric telemetry snapshot only through injected/test seams; normal `WhylineReport` and CLI output remain unchanged and sanitized.

- [ ] **Step 1: Add failing integration tests** for proof-derived omissions versus candidate-cap omissions, candidate-cap blocking `matched`, two-strong `ambiguous` despite uncertainty, deterministic worker-limit results, and recursively privacy-safe fixed numeric telemetry.
- [ ] **Step 2: Run the focused integration tests** and confirm failures demonstrate missing coverage/telemetry behavior.
- [ ] **Step 3: Integrate proof states before ranking/cap**, project at most 32 potentially-strong artifacts, propagate per-ref failures/material limitations, then call the existing pure scorer and selection logic.
- [ ] **Step 4: Update selection coverage** so exactly one strong is matched only with zero omitted potentially-strong refs and no material limitation; preserve two-strong ambiguity and all existing signal/contradiction rules.
- [ ] **Step 5: Implement fixed metric names and zero defaults** with recursive structural validation tests; reject paths, session IDs, transcript names, repositories, branches, errors, diagnostics, and non-numeric values.
- [ ] **Step 6: Run all correlation/e2e/privacy tests, typecheck, and build.**

### Task 6: Synthetic verification and focused spec review

**Files:**
- Modify: `test/codex-history.test.ts`
- Modify: `test/provenance-correlation-flow.test.ts`
- Modify: `test/correlation-decision-table.test.ts`
- Modify: `test/correlation-e2e.test.ts`
- Modify: `test/fixtures/codex/README.md`

- [ ] **Step 1: Add or adjust fixture-only tests** for namespace mutation, all proof/cannot-prove boundaries, cache and zero-reread behavior, bounded calls, failure propagation, unchanged decision rows, synthetic P1 matched, synthetic P2 ambiguous, read-only Git/no-network, and no personal `~/.codex` access.
- [ ] **Step 2: Run the complete project verification**: `git diff --check`, `npm run typecheck`, `npm run build`, `npm test`, and `npm run check`.
- [ ] **Step 3: Inspect the diff and repository status** for raw transcript/source material, persistent cache writes, network/process-command execution, accidental renderer changes, or unrelated refactors.
- [ ] **Step 4: Perform one focused review against the frozen design** and make at most one concrete correction wave; stop and report if a load-bearing issue remains.

### Task 7: Controlled actual-source P1/P2 and performance validation

**Files:**
- Create: `docs/validation/2026-08-09-correlation-hardening-validation.md`
- Modify: `docs/validation/2026-08-09-correlation-hardening-preflight.md` only if aggregate validation facts require a factual addendum

- [ ] **Step 1: Create disposable validation Git repositories and dedicated `CODEX_HOME` directories** containing only invented content, no remotes, no personal mounts, and no unrelated credentials; keep original rollouts outside the repository under the seven-day-or-acceptance retention rule.
- [ ] **Step 2: Generate actual supported Codex P1/P2 rollouts** through the minimum Codex client/model-service boundary, quiesce them, and run Whyline offline from a non-Codex shell.
- [ ] **Step 3: Validate P1** as one individually strong candidate with complete coverage, zero omitted potentially-strong refs, and `matched`.
- [ ] **Step 4: Validate P2** by proving each session individually strong, then retaining both and asserting exactly two strong candidates, complete coverage, no cap limitation, and `ambiguous`.
- [ ] **Step 5: Derive only sanitized fixtures/aggregate results**, delete original rollouts when accepted or at seven days, and record retention/deletion state without source-session identifiers.
- [ ] **Step 6: Capture at least five warm baseline and hardened runs** on a fresh representative ~400 MiB corpus with comparable conditions, report medians and fixed stage metrics, and report any missed 20% objective without weakening correctness/privacy.

