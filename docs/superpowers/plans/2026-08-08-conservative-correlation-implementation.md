# Conservative Git ↔ Codex Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combine committed-line Git provenance with bounded local Codex evidence while selecting a session only when exactly one strongly supported candidate remains and coverage proves uniqueness.

**Architecture:** Keep Git and agent-history facts in their existing adapters. Add a pure, agent-neutral `src/correlation/` domain that consumes a narrow Git-derived `CorrelationTarget`, typed candidate inputs, operation-aware patch fingerprints, repository compatibility, and typed coverage. Put discovery, summary filtering, read-only commit resolution, the 32-candidate cap, and evidence extraction in a small provenance coordinator; pass only the combined normalized result to a bounded renderer.

**Tech Stack:** TypeScript 5.9, Node.js 24, `node:test`, existing argv-based Git runner, existing Codex JSONL adapter, no runtime dependencies, no network access, no persistent index.

## Global Constraints

- Keep `CorrelationTarget` narrow, Git-derived, and independent of renderer and Codex parser state.
- Rename the agent extraction hint to `AgentEvidenceTarget`; it is not the rich correlation target.
- Resolve repository compatibility before scoring; known incompatible `commonGitDir` is an exclusion, never a negative score.
- Treat `session_meta.payload.git.commit_hash` and current `git-revision-reference` evidence as `session-head` context, never as proof that the session produced the commit.
- Require qualifying structured patch overlap for current-v0 `strong`; a future `produced-commit` reference is reserved and is not emitted.
- Use only successful recovered structured patch payloads for direct hunk overlap; do not parse shell strings, prompts, reasoning, or output.
- Require at least two distinctive line fingerprints for a direct overlap or content-divergence anchor.
- Keep candidate confidence separate from discovery/evidence/Git-hunk coverage.
- `matched` requires exactly one strong candidate and complete candidate-set coverage with no material limitation.
- Two strong candidates always produce `ambiguous`; one strong candidate with material coverage produces `none` with possible evidence retained.
- A readable Codex home with zero refs is `available` and leads toward `none`; unavailable/unreadable effective history is `unavailable`; partially readable stores are `limited`.
- Do not discover Codex history for uncommitted or untracked queried lines.
- Never render raw prompts, transcript output, commands, patch source, repository URLs, sensitive absolute paths, or score/probability values.
- Automated tests use temporary synthetic Codex homes or injected sources and never read the real `~/.codex`.
- Git operations remain read-only and use argv arrays; transcript commands are never executed.
- Do not add a cache, index, SQLite database, remote fetch, PR, or new agent provider.

---

## File map

Create the following focused files:

- `src/correlation/model.ts` — closed signal, target, candidate, coverage, and result types.
- `src/correlation/patch-overlap.ts` — pure operation-aware Git/Codex fingerprint comparison and divergence locality helpers.
- `src/correlation/build-candidates.ts` — pure eligibility and candidate-input construction from precomputed repository classification and evidence.
- `src/correlation/score-candidate.ts` — centralized weights, signals, contradictions, confidence bands, and pure scoring.
- `src/correlation/correlate.ts` — pure candidate-set coverage and final `matched | ambiguous | none | unavailable` selection.
- `src/provenance/build-correlation-target.ts` — converts the committed `GitProvenance` and repository context into the narrow target.
- `src/provenance/correlate-codex.ts` — staged discovery, summary filtering, repository classification, read-only commit-reference resolution, bounded extraction, and orchestration into the pure domain.
- `src/provenance/resolve-commit-reference.ts` — safe current-repository full/abbreviated object resolution through the existing Git runner.
- `src/cli/render-correlation.ts` — fixed explanation mapping and collision-safe session-ID presentation.

Modify these existing files:

- `src/agents/agent-history-source.ts`, `src/agents/codex/source.ts`, `src/agents/codex/discover.ts`, `src/agents/codex/parse-transcript.ts`, `src/agents/codex/extract-evidence.ts`, and `src/agents/codex/safe.ts` for the smallest normalized-contract widening.
- `src/provenance/model.ts` and `src/provenance/explain-location.ts` for the optional combined result and committed-only flow.
- `src/cli/render-text.ts` to append the combined normalized result while preserving Git-only wording.
- `test/codex-history.test.ts`, `test/git-provenance.test.ts`, and new pure/staged/end-to-end test files for decision tables and integration coverage.

## Task 1: Lock the agent-neutral contract seams

**Files:**

- Modify: `src/agents/agent-history-source.ts`
- Modify: `src/agents/codex/source.ts`
- Modify: `src/agents/codex/discover.ts`
- Modify: `src/agents/codex/parse-transcript.ts`
- Modify: `src/agents/codex/extract-evidence.ts`
- Test: `test/codex-history.test.ts`

**Interfaces:**

- Replace the existing extraction-hint name with:

  ```ts
  export interface AgentEvidenceTarget {
    readonly repositoryPath?: string;
    readonly line?: number;
    readonly worktreeRoot?: string;
  }
  ```

- Add:

  ```ts
  export type AgentHistoryAvailability = "available" | "limited" | "unavailable";

  export interface AgentHistoryDiscoveryResult {
    readonly availability: AgentHistoryAvailability;
    readonly refs: readonly AgentSessionRef[];
    readonly diagnostics: readonly AgentDiagnostic[];
  }
  ```

- Change `AgentHistorySource.extractEvidence` to accept `target?: AgentEvidenceTarget` and add optional `discoverWithDiagnostics(context?: AgentHistoryDiscoveryContext)` without removing the existing async `discover` method.
- Add `AgentCommitReferenceKind = "session-head" | "produced-commit" | "unknown"` and carry it on summary `transcriptGit` and `AgentEvidence` reference records. The current Codex adapter always emits `session-head` for `session_meta.payload.git.commit_hash` and emits no `produced-commit` kind.

- [ ] **Step 1: Add failing contract assertions.**

  Extend `test/codex-history.test.ts` with assertions that a T3 summary exposes the session-head reference kind, a `git-revision-reference` evidence record exposes the same kind, and an empty readable synthetic Codex home is distinguishable from an unreadable home.

- [ ] **Step 2: Run the focused tests and verify they fail for the missing fields.**

  Run:

  ```bash
  npm run build && node --test dist/test/codex-history.test.js
  ```

  Expected: failures identify the missing availability/reference-kind contract fields.

- [ ] **Step 3: Implement only the contract seam.**

  Rename imports and method parameters without changing parser behavior. In `discoverCodexSources`, check the effective home read access separately from optional store directories, return `unavailable` for an unreadable/missing effective home, return `available` for a readable home with zero readable refs, and return `limited` when a store or transcript is partially unreadable. Preserve archive-optional behavior. Annotate current session metadata references as `session-head`.

- [ ] **Step 4: Run the focused tests and the existing adapter tests.**

  Run:

  ```bash
  npm run build && node --test dist/test/codex-history.test.js
  ```

  Expected: all Codex adapter tests pass, including filename-independent identity and archive-optional discovery.

- [ ] **Step 5: Commit the contract seam.**

  ```bash
  git add src/agents test/codex-history.test.ts
  git commit -m "feat: widen agent correlation contracts"
  ```

## Task 2: Normalize operation-aware structured patch evidence

**Files:**

- Modify: `src/agents/agent-history-source.ts`
- Modify: `src/agents/codex/safe.ts`
- Modify: `src/agents/codex/extract-evidence.ts`
- Test: `test/codex-history.test.ts`

**Interfaces:**

- Add the privacy-safe fields to `AgentPatchChange`:

  ```ts
  export interface AgentPatchHunkRange {
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
  }

  export type AgentPatchMatchSide = "added" | "deleted" | "content";

  export interface AgentPatchChange {
    readonly path: string;
    readonly changeType: "update" | "add" | "delete" | "unknown";
    readonly payloadKind: "unified-diff" | "content";
    readonly payloadRecovered: boolean;
    readonly payloadFingerprint: string;
    readonly payloadTruncated: boolean;
    readonly addedLineFingerprints: readonly string[];
    readonly matchLineFingerprints: readonly string[];
    readonly distinctiveLineFingerprints: readonly string[];
    readonly matchSide: AgentPatchMatchSide;
    readonly hunkRanges: readonly AgentPatchHunkRange[];
    readonly lineCount: number;
    readonly movedFrom?: string;
  }
  ```

- Normalize the fields exactly as follows:
  - `update + unified-diff`: added lines, `matchSide: "added"`, and parsed numeric unified-diff ranges.
  - `add + content`: bounded post-image content lines, `matchSide: "content"`, and no ranges.
  - `delete + content`: bounded deleted-content lines, `matchSide: "deleted"`, and no ranges.
  - `addedLineFingerprints` remains the compatibility alias for update/add and is empty for delete/content.

- [ ] **Step 1: Add failing table cases for update, add, delete, truncation, and distinctiveness.**

  Use synthetic `patch_apply_end` records in `test/codex-history.test.ts`. Assert side-specific fingerprints, parsed `@@ -old,count +new,count @@` coordinates, empty delete aliases, at least two retained distinctive fingerprints for meaningful payloads, and no raw payload/source text in the bundle.

- [ ] **Step 2: Run the focused adapter tests and verify the new cases fail.**

  ```bash
  npm run build && node --test dist/test/codex-history.test.js
  ```

- [ ] **Step 3: Implement bounded fingerprint extraction.**

  Add a single line-classification helper beside the existing digest utilities. Normalize only CRLF/CR to LF before hashing; classify nonempty non-punctuation/non-boilerplate lines without retaining the source. Parse unified-diff headers while extracting added lines. Keep line and change caps from `safe.ts`; set `payloadTruncated` when the bounded payload omits bytes.

- [ ] **Step 4: Run adapter tests and inspect serialized bundles for privacy.**

  ```bash
  npm run build && node --test dist/test/codex-history.test.js
  ```

  Expected: update/add/delete tests pass and fixture secrets, patch source, and raw command text do not appear in serialized evidence.

- [ ] **Step 5: Commit the patch contract implementation.**

  ```bash
  git add src/agents test/codex-history.test.ts
  git commit -m "feat: retain operation-aware patch fingerprints"
  ```

## Task 3: Build the pure correlation domain and hunk matcher

**Files:**

- Create: `src/correlation/model.ts`
- Create: `src/correlation/patch-overlap.ts`
- Test: `test/correlation-patch.test.ts`

**Interfaces:**

- Define the approved closed `CorrelationSignalKind`, `CorrelationRepositoryMatch`, `CorrelationLimitationKind`, `CorrelationSignal`, `CorrelationTarget`, `CorrelationCandidate`, `CorrelationCoverage`, and `CorrelationResult` types from the committed specification.
- Define the orchestration-to-domain input types explicitly:

  ```ts
  export interface ResolvedCommitReference {
    readonly kind: AgentCommitReferenceKind;
    readonly reference: string;
    readonly resolution: "target" | "other" | "ambiguous" | "unresolved";
  }

  export interface CorrelationCandidateInput {
    readonly session: AgentSessionSummary;
    readonly evidence: AgentEvidenceBundle | null;
    readonly repositoryMatch: CorrelationRepositoryMatch;
    readonly eligible: boolean;
    readonly references: readonly ResolvedCommitReference[];
    readonly coverageLimitations: readonly CorrelationLimitation[];
  }
  ```
- Keep the target Git-derived and source-bounded:

  ```ts
  export interface CorrelationTarget {
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
    readonly commit: { readonly id: string; readonly authoredAt: string; readonly committedAt: string };
    readonly selectedParentId: string | null;
    readonly changedPaths: readonly { readonly oldPath: string | null; readonly newPath: string | null }[];
    readonly relevantHunks: readonly CorrelationHunk[];
  }
  ```

- Export pure helpers with no filesystem/Git/transcript access:

  ```ts
  export function comparePatchChangeToHunks(
    target: CorrelationTarget,
    change: AgentPatchChange,
  ): PatchOverlap;

  export function hasCompetingStructuredDivergence(
    target: CorrelationTarget,
    changes: readonly AgentPatchChange[],
  ): boolean;
  ```

- [ ] **Step 1: Add failing patch-overlap table tests.**

  Cover update/add/delete side matching, two-line distinctiveness, boilerplate-only rejection, path matching for current/blamed/rename paths, truncated payload rejection, update hunk locality, content-only non-overlap not becoming divergence, and truncated Git hunk suppression of divergence.

- [ ] **Step 2: Run the pure patch tests and verify they fail.**

  ```bash
  npm run build && node --test dist/test/correlation-patch.test.js
  ```

- [ ] **Step 3: Implement the pure matcher.**

  Compare only operation-compatible sides and distinctive fingerprints. Require two distinctive intersections for a direct anchor. Use hunk ranges to establish update locality; require direct fingerprint overlap before reporting a content-only relation. Return typed reasons/booleans for the scorer rather than display strings. Treat any relevant `truncated` Git hunk as unknown for absence/divergence.

- [ ] **Step 4: Run the patch tests and strict typecheck.**

  ```bash
  npm run typecheck
  npm run build && node --test dist/test/correlation-patch.test.js
  ```

- [ ] **Step 5: Commit the pure target/matcher domain.**

  ```bash
  git add src/correlation test/correlation-patch.test.ts
  git commit -m "feat: add pure correlation target and patch matching"
  ```

## Task 4: Implement eligibility, signals, bands, and final selection as pure functions

**Files:**

- Create: `src/correlation/build-candidates.ts`
- Create: `src/correlation/score-candidate.ts`
- Create: `src/correlation/correlate.ts`
- Test: `test/correlation-decision-table.test.ts`

**Interfaces:**

- `build-candidates.ts` consumes summaries, precomputed repository classifications, and resolved reference results. It must exclude incompatible common Git directories before scoring and preserve unknown/deleted cwd candidates only when the summary-level anchor rule allows bounded extraction.
- `score-candidate.ts` consumes only normalized domain values. Centralize weights in one readonly table in that file:

  ```ts
  export const CORRELATION_WEIGHTS = {
    sessionHeadTargetReference: 2,
    producedTargetCommitReference: 10,
    structuredPatchOverlap: 8,
    exactCurrentWorktree: 5,
    linkedWorktreeCommonDirectory: 4,
    structuredPatchTargetPath: 4,
    changedPathOverlap: 3,
    structuredPatchAttemptTargetPath: 1,
    temporalProximityDay: 1,
    temporalProximityHour: 2,
    structuredContentDivergence: -5,
  } as const;
  ```

- `correlate.ts` must accept global coverage explicitly and return `CorrelationResult`; it must not infer source availability from `refs.length`.
- Export `scoreCandidate(target: CorrelationTarget, input: CorrelationCandidateInput): CorrelationCandidate` and `correlate(target: CorrelationTarget, inputs: readonly CorrelationCandidateInput[], coverage: CorrelationCoverage): CorrelationResult`.
- [ ] **Step 1: Add the failing decision table.**

  Use table rows for:

  1. same repository + session-head SHA without patch → weak/not strong;
  2. same repository + distinctive structured overlap → strong;
  3. stale/rebased session-head SHA + current patch overlap → strong;
  4. unknown/deleted cwd + resolved session-head target + patch overlap → historical strong;
  5. exact SHA with unknown repository and no patch → not selected;
  6. same filename + time, repository + time, and test/command activity → weak;
  7. repository + changed-path overlap → plausible at most;
  8. patch attempt without successful recovered payload → weak support only;
  9. known repository mismatch → ineligible regardless of score;
  10. matching basename in another repository → ineligible;
  11. earlier divergence/later match, earlier match/later divergence, unrelated same-file hunk, and only divergence;
  12. two strong, one strong plus plausible, two plausible, root plus subagent strong, squash overlap, human-edited related content;
  13. benign unknown record, material compaction/corruption, changed-during-read, unsupported summary, candidate cap, and truncated Git hunk.

- [ ] **Step 2: Run the decision table and verify the unimplemented pure functions fail.**

  ```bash
  npm run build && node --test dist/test/correlation-decision-table.test.js
  ```

- [ ] **Step 3: Implement pre-score eligibility.**

  Return `eligible: false` for known incompatible repository context. Return `unknown` without a positive repository signal for missing/deleted cwd. Permit historical evaluation only for a safely resolved session-head/object anchor; require the anchor plus qualifying patch overlap for `strong`.

- [ ] **Step 4: Implement signals and confidence bands.**

  Add only closed signal kinds. Resolve exact/abbreviated reference outcomes supplied by the orchestrator; do not call Git here. Keep session-head at `+2` contextual ordering only. Require credible repository compatibility plus qualifying structured patch overlap and no active divergence for current-v0 `strong`. Require two independent signals including successful patch target/change-path overlap for `plausible`; a patch attempt alone cannot qualify.

- [ ] **Step 5: Implement final selection and coverage gates.**

  Return `ambiguous` for two or more strong candidates before score tie-breaking. Return `matched` only for one strong candidate with no material coverage limitation, no omitted eligible candidate, and no truncated relevant Git hunk. Return `none` for plausible-only or strong-with-insufficient-coverage while retaining the possible candidate. Return `unavailable` only when the explicit discovery availability is unavailable.

- [ ] **Step 6: Run all pure correlation tests and commit.**

  ```bash
  npm run typecheck
  npm run build && node --test dist/test/correlation-*.test.js
  git add src/correlation test/correlation-*.test.ts
  git commit -m "feat: add conservative correlation decision rules"
  ```

## Task 5: Add Git target construction and staged Codex orchestration

**Files:**

- Create: `src/provenance/build-correlation-target.ts`
- Create: `src/provenance/resolve-commit-reference.ts`
- Create: `src/provenance/correlate-codex.ts`
- Modify: `src/provenance/model.ts`
- Modify: `src/provenance/explain-location.ts`
- Modify: `src/agents/codex/source.ts`
- Test: `test/provenance-correlation-flow.test.ts`

**Interfaces:**

- Add `correlation?: CorrelationResult` to `WhylineReport`; leave the existing `GitProvenance` facts unchanged.
- Add analysis-only injection:

  ```ts
  export interface AnalyzeLocationOptions {
    readonly currentDirectory?: string;
    readonly git?: GitRunner;
    readonly hooks?: AnalysisHooks;
    readonly agentHistorySource?: AgentHistorySource;
    readonly codexHome?: string;
  }
  ```

- Build the target only when `provenance.state === "committed"`:

  ```ts
  export function buildCorrelationTarget(
    repository: RepositoryContext,
    location: ResolvedCodeLocation,
    provenance: GitProvenance,
  ): CorrelationTarget | null;
  ```

- Resolve references through the existing `GitRunner` with read-only argv calls. Full IDs compare directly; abbreviations contribute only after unique current-repository resolution; ambiguous/unresolvable IDs contribute no signal. Never use remote or shell strings.

- [ ] **Step 1: Add failing orchestration seam tests.**

  Use a fake `AgentHistorySource` that records calls. Assert an uncommitted and an untracked query returns before `discover`, a committed query passes a narrow target hint to evidence extraction, and a committed query includes a normalized correlation result on the report.

- [ ] **Step 2: Run the flow tests and verify they fail before integration exists.**

  ```bash
  npm run build && node --test dist/test/provenance-correlation-flow.test.js
  ```

- [ ] **Step 3: Implement `buildCorrelationTarget`.**

  Copy only repository roots/object format/worktree mappings, target/current and blamed/previous paths, commit times/ID, selected commit parent when available, changed old/new paths, and bounded Git hunk fingerprints/ranges. Do not pass `WhylineReport`, raw Git hunk text, renderer values, or Codex event records to the pure layer.

- [ ] **Step 4: Implement read-only reference resolution and repository classification.**

  Canonically compare transcript working directories with the current worktree and linked worktree mappings. For an existing historical cwd, use the Git runner to inspect its common Git directory; classify a known different common directory as ineligible. A missing/deleted cwd supplies no positive repository signal. Resolve summary/evidence commit IDs against the current repository without fetching.

- [ ] **Step 5: Implement staged discovery and bounded extraction.**

  Obtain explicit discovery availability from `discoverWithDiagnostics`. Read summaries for every discovered ref, count unsupported summaries and diagnostics, exclude incompatible candidates, rank by resolved session-head/object anchor, current/linked worktree match, bounded time, and opaque source path, then extract full evidence for at most 32 eligible candidates. Every omitted eligible ref creates material `candidate-cap` coverage; an unknown-repository candidate omitted for lack of a safe summary anchor creates material `unresolved-repository-candidate` coverage.

- [ ] **Step 6: Integrate the committed-only flow into `analyzeLocation`.**

  Keep the existing Git branch and mutation verification. After committed Git inspection, run Codex correlation with the injected source/home; before any Codex call, return the existing Git-only report for uncommitted/untracked state. Preserve Git success when the source is empty, limited, unavailable, or unreadable, attaching the typed correlation result and limitation rather than changing the exit code.

- [ ] **Step 7: Run flow tests and the full existing suite, then commit.**

  ```bash
  npm run check
  git add src/provenance src/agents/codex/source.ts test/provenance-correlation-flow.test.ts
  git commit -m "feat: stage Codex correlation from Git provenance"
  ```

## Task 6: Add the combined normalized terminal report

**Files:**

- Create: `src/cli/render-correlation.ts`
- Modify: `src/cli/render-text.ts`
- Test: `test/correlation-render.test.ts`

**Interfaces:**

- Render only `CorrelationResult`; do not accept an agent adapter, transcript ref, Git runner, or raw evidence bundle.
- Derive explanations from closed signal, contradiction, limitation, and result-status kinds through fixed strings. Never include score, probability, raw source, prompt, command, output, URL, or absolute transcript path.

- [ ] **Step 1: Add failing renderer cases.**

  Assert exact bounded output for matched, ambiguous, possible-only, none, and unavailable results. Include two strong session IDs with the same initial displayed prefix and require the renderer to extend the prefix until both displayed IDs are distinct. Assert a prompt secret, patch source line, command string, URL, and absolute transcript path are absent.

- [ ] **Step 2: Run the renderer tests and verify they fail.**

  ```bash
  npm run build && node --test dist/test/correlation-render.test.js
  ```

- [ ] **Step 3: Implement fixed rendering and collision-safe IDs.**

  Start with a bounded prefix, increase it until every displayed candidate in the same report has a unique prefix, and use the full structured session ID when needed. Never derive an ID from `sourcePath` or a filename. Render “Likely related Codex session” only for a selected match; render “Possible related session” for a lone plausible/retained strong candidate with insufficient coverage; render no selection for ambiguity.

- [ ] **Step 4: Attach the section without changing Git output.**

  Have `renderText` append `Codex evidence` only when a committed report has a correlation result. Leave uncommitted/untracked Git-only output unchanged and keep exit code `0` for all readable/unavailable Codex states.

- [ ] **Step 5: Run renderer and full tests, then commit.**

  ```bash
  npm run check
  git add src/cli test/correlation-render.test.ts
  git commit -m "feat: render bounded Codex correlation evidence"
  ```

## Task 7: Prove synthetic end-to-end behavior and scan bounds

**Files:**

- Create: `test/correlation-e2e.test.ts`
- Create: `test/fixtures/codex/correlation-*.jsonl` only for reusable redacted payloads that cannot be expressed inline.
- Modify: `test/codex-history.test.ts` if the end-to-end fixture needs a shared synthetic Codex-home helper.
- Modify: `test/git-provenance.test.ts` if the end-to-end fixture needs a shared temporary-Git-repository helper.

**Interfaces:**

- Use temporary Git repositories built through the existing fixture helpers and a temporary synthetic Codex home passed through `codexHome` or an injected `AgentHistorySource`.
- Use synthetic records with stable session IDs, fixed UTC timestamps, safe paths, and distinctive two-line patch payloads.

- [ ] **Step 1: Add failing end-to-end cases.**

  Add cases for matching structured patch → `matched`; unrelated session → `none`; two matching sessions → `ambiguous`; plausible-only evidence → `none` with possible rendering; empty/missing Codex history with successful Git-only output; uncommitted target with zero discovery calls; stale SHA plus equivalent current patch; and privacy-sensitive transcript material absent from output.

- [ ] **Step 2: Add the bounded-scan case.**

  Provide 40 synthetic refs through a fake source. Count `readSummary` calls and `extractEvidence` calls. Assert all summaries are read, no more than 32 candidates receive full extraction, `candidate-cap` is material, and a strong observed candidate cannot become `matched` under incomplete candidate-set coverage.

- [ ] **Step 3: Add worktree, rewrite, operation, and coverage cases.**

  Exercise current worktree, linked worktree/common Git directory, deleted cwd with a resolved session-head plus patch, unrelated known repository, update/add/delete matching, earlier/later competing patches, benign unknown record, material partial/corrupt transcript, changed-during-read, compaction that materially hides relevant evidence, and a truncated Git hunk.

- [ ] **Step 4: Run the synthetic suite and inspect privacy/network behavior.**

  ```bash
  npm run build && node --test dist/test/correlation-e2e.test.js
  npm run check
  ```

  Expected: no test opens the real home, no transcript command is invoked, no remote Git command is used, and only the approved bounded report text is rendered.

- [ ] **Step 5: Commit end-to-end and performance coverage.**

  ```bash
  git add test
  git commit -m "test: cover staged Git Codex correlation"
  ```

## Task 8: Final documentation and release verification

**Files:**

- Modify: `docs/whyline-v0-architecture.md` only for implementation-established behavior that differs from the committed specification.
- Review: `docs/superpowers/specs/2026-08-08-conservative-correlation-design.md`
- Review: `docs/codex-transcript-preflight.md`

- [ ] **Step 1: Run the complete verification commands.**

  ```bash
  npm run check
  npm pack --dry-run --json
  git diff --check
  ```

- [ ] **Step 2: Run explicit operational audits.**

  Search the implementation and tests for forbidden behavior:

  ```bash
  rg -n "exec\(|spawn\(|shell:|history\.jsonl|~/.codex|remote|fetch|confidence|%" src test
  ```

  Review each result against the existing argv Git boundary, test-only temporary homes, and renderer constraints. Confirm transcript strings are never passed to a shell and scores are not rendered.

- [ ] **Step 3: Verify the final invariants with focused tests.**

  Confirm that known repository contradictions cannot be outweighed, time-only evidence cannot match, plausible-only evidence cannot select, two strong candidates remain ambiguous, uncommitted targets make no discovery call, supported patch variants are the only direct-overlap source, and truncated Git hunks block `matched` without creating divergence.

- [ ] **Step 4: Make only necessary documentation corrections.**

  Update the architecture document if implementation establishes a concrete seam or limitation not already stated. Do not rewrite the plan or preflight; preserve the fact/derived/inferred boundary.

- [ ] **Step 5: Commit documentation and verification changes.**

  ```bash
  git add docs
  git commit -m "docs: record integrated correlation behavior"
  ```

- [ ] **Step 6: Inspect history and push the verified feature branch without a PR.**

  ```bash
  git log --oneline --decorate -n 15
  git diff --stat main...HEAD
  git status --short
  git push origin feat/conservative-correlation
  ```

  Expected: the branch is pushed without force, `main` is not rewritten, no PR is created, and the final report includes the verification results, remote branch state, known limitations, and the exact three requested Git summaries.

## Self-review checklist before implementation

- [ ] Every current-v0 strong path has qualifying structured patch overlap; session-head metadata alone is never strong.
- [ ] Deleted/relocated cwd is not automatically excluded, but unknown repository context needs the resolved target-reference plus patch conjunction for strong.
- [ ] Update/add/delete patch semantics use side-appropriate fingerprints and no raw source.
- [ ] Earlier/later structured changes are evaluated chronologically; unrelated same-file edits do not create divergence.
- [ ] Any truncated relevant Git hunk creates `truncated-git-hunk`, permits individual observed strong, and blocks final `matched`.
- [ ] Availability is explicit: unavailable home, available empty store, and limited partially readable store are distinct.
- [ ] Candidate cap and unsupported/omitted summaries prevent uniqueness claims.
- [ ] Renderer explanations come from closed kinds, and displayed session IDs are unambiguous without filename fallback.
- [ ] No production implementation begins until this plan is approved.
