# Exact Git-Visible Ancestry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conservative exact Git-visible ancestry to committed single-line Whyline reports and make the default CLI concise and explanation-first without changing baseline blame or Codex correlation semantics.

**Architecture:** Keep the existing baseline Git provenance and Codex correlation pipeline authoritative. After committed baseline provenance is assembled, run a dedicated read-only ancestry tracer in parallel with correlation; the tracer treats one `git blame -M -C` result as a candidate and requires proper reachability plus a pure exact-block proof. Render a compact summary by default and retain the existing forensic renderer behind `--details`.

**Tech Stack:** TypeScript 5.9, Node.js 24, ESM, built-in `node:test`, existing `GitRunner`/`GitProcess`, argv-only `shell:false` Git subprocesses, no runtime dependencies.

## Global Constraints

- Candidate commit `A` must satisfy `A != T` and be positively established as a reachable ancestor of textual last-touch commit `T`.
- Baseline textual blame invocation must remain unchanged.
- The movement-aware candidate query uses exactly one `-M` and one `-C`; its attribution is never ancestry evidence by itself.
- Exact proof compares lines byte-for-byte after line-ending splitting only; no whitespace, case, token, fuzzy, edit-distance, or similarity normalization is permitted.
- A proof must contain the queried line, at least 2 unique distinctive exact lines, and at least 40 alphanumeric characters within bounded complete material.
- Dirty/untracked queries without committed attribution do not run ancestry.
- Root, shallow, missing-object, merge ambiguity, transformation, generic context, and absent ancestry remain conservative typed outcomes.
- Ancestry cannot alter the Codex correlation target, thresholds, caps, confidence, coverage, or status.
- Git remains local, read-only, offline, argv-only, and `shell:false`; no config writes, worktree mutations, or network commands.
- The CLI accepts `<file>:<line>` and `--details <file>:<line>` only; no JSON, ranges, symbols, or other query forms.
- Concise output never claims semantic origin; details output remains bounded and privacy-safe.

---

### Task 1: Ancestry model and pure exact-block proof

**Files:**
- Create: `src/ancestry/model.ts`
- Create: `src/ancestry/exact-block-proof.ts`
- Create: `src/correlation/distinctive-line.ts` if extraction is needed
- Modify: `src/provenance/build-correlation-target.ts` only to consume the shared predicate
- Test: `test/ancestry-proof.test.ts`
- Test: the existing distinctiveness test file containing `isDistinctiveLine` coverage

**Interfaces:**
- Produces `GitAncestryStatus`, `ExactTransitionKind`, `ExactBlockProof`, `GitLineAncestor`, and `GitAncestryResult` with the approved exact/uncertain/none/unavailable variants.
- Produces `proveExactBlock(input: ExactBlockInput): ExactBlockProof | null`.
- `ExactBlockInput` contains complete current/ancestor line arrays, one-based queried/current and candidate/ancestor lines, and completeness booleans for both arrays.
- An exact result includes `relationship: "exact-ancestor"`, transition, ancestor location, proof, and limitations. For renderer support, exact and uncertain results may carry bounded commit subject/candidate metadata as a type-level refinement; this metadata is factual Git output and does not change status semantics.

- [ ] **Step 1: Write failing proof tests for the approved thresholds.**

  Add one focused test per behavior: aligned exact block, expansion around the aligned lines, rejection when the queried line is not contained, rejection with only one unique distinctive line, rejection below 40 alphanumeric characters, rejection of repeated/generic lines, rejection of whitespace-only differences, rejection of partial transformation, rejection of incomplete material, and a maximum-context test proving the returned block is bounded.

  Use exact strings with at least two clearly distinct non-boilerplate lines for positive cases. Assert the returned `currentStartLine`, `ancestorStartLine`, `matchedLineCount`, `distinctiveLineCount`, `alphanumericCount`, and `comparison: "exact-lines"`.

- [ ] **Step 2: Run the proof tests and confirm they fail for the missing module/API.**

  Run:

  ```bash
  npm run build
  ```

  Expected: TypeScript fails because the proof module and model do not yet exist. Correct any test/import typo until the failure is specifically the absent implementation.

- [ ] **Step 3: Extract the existing distinctiveness predicate without changing its behavior.**

  Move only `BOILERPLATE_LINES` and `isDistinctiveLine` from `src/provenance/build-correlation-target.ts` into a small shared internal module, export the predicate for the proof module, and update `build-correlation-target.ts` to import it. Keep the existing trim, punctuation/symbol-only, identifier-only, boilerplate, and simple return/throw/yield rules byte-for-byte equivalent.

- [ ] **Step 4: Implement the minimal pure bounded proof.**

  In `src/ancestry/exact-block-proof.ts`, reject out-of-range lines or either incomplete input. Require the two aligned lines to match exactly, then expand up and down only while corresponding lines are exactly equal and the total proof length stays within a fixed constant of 32 lines. Count unique exact line strings that pass the shared predicate and count Unicode letters/numbers across the selected lines. Return `null` unless the query is inside the block, the unique distinctive count is at least 2, and the alphanumeric count is at least 40.

- [ ] **Step 5: Run the focused proof and distinctiveness tests green.**

  Run:

  ```bash
  npm run build && node --test dist/test/ancestry-proof.test.js dist/test/correlation-patch.test.js
  ```

  Expected: all new proof cases pass and the existing distinctiveness/fingerprint cases remain green with their prior behavior.

---

### Task 2: Read-only Git candidate discovery and ancestry classification

**Files:**
- Create: `src/git/trace-line-ancestry.ts`
- Modify: `src/git/blame-line.ts` only for reusable structured parsing, without changing `blameLine` arguments
- Test: `test/git-ancestry.test.ts`
- Test: `test/git-provenance.test.ts` only for read-only command-family assertions if required

**Interfaces:**
- Produces `traceLineAncestry(runner, context, location, provenance): Promise<GitAncestryResult>`.
- Consumes the committed baseline `GitProvenance`, `RepositoryContext`, `ResolvedCodeLocation`, the existing `parseBlamePorcelain`, and `proveExactBlock`.
- Uses a private safe object resolver that returns a complete blob line set or a typed unavailable condition; it never accepts a user-controlled revision/path expression.

- [ ] **Step 1: Add failing real-Git fixtures for same-file movement and proper-ancestor anchoring.**

  Extend the disposable fixture helpers in `test/git-ancestry.test.ts` to create a root/base commit with a distinctive four-line block, a refactor commit that moves the block, and a query against the moved line. Assert baseline provenance still identifies the refactor commit while ancestry is initially unavailable at the missing implementation boundary. Add a negative fixture where the candidate attribution equals `T`; assert it cannot become exact.

- [ ] **Step 2: Add failing fixtures for cross-file movement/copy, connected rename, transformed text, generic duplicates, and unchanged attribution.**

  Use separate commits for each case. The positive cross-file case must retain exact lines and assert `cross-file-move-or-copy`; the rename case must provide `GitPathChange.kind === "renamed"` connected to the proven source/current paths and assert `renamed-path`. The transformed and whitespace-only cases must assert non-exact outcomes. The generic duplicate must fail the proof thresholds. An unchanged line with no older movement candidate must assert `none / no-earlier-move-copy-attribution`.

- [ ] **Step 3: Add failing conservative-history fixtures.**

  Cover a true root attribution (`none / root-history-boundary`), a depth-one clone where no complete positive proof is available (`unavailable / missing-history`), an unavailable blob/object seam (`unavailable / unsupported-object` or `missing-history` when shallow), and an ambiguous merge parent (`unavailable / ambiguous-parent`). Add Unicode source/current paths and a SHA-256 repository test that skips only when Git cannot initialize that object format.

- [ ] **Step 4: Run the focused Git ancestry tests and verify they fail for the intended missing tracer.**

  Run:

  ```bash
  npm run build && node --test dist/test/git-ancestry.test.js
  ```

  Expected: tests compile only after the model exists and then fail because `traceLineAncestry` is not implemented or returns no result. Do not weaken assertions to make the tests pass.

- [ ] **Step 5: Implement the exact candidate query and porcelain handling.**

  Preserve `blameLine` exactly. Add a separate invocation with arguments equivalent to:

  ```text
  -c core.quotePath=false -c color.ui=false blame --line-porcelain -M -C -L L,L T -- P
  ```

  Use `blame.originalLine`, `blame.objectId`, and `blame.filename` from baseline for `L`, `T`, and `P`. Parse the candidate with the existing bounded porcelain parser. Reject malformed/all-zero candidates as unavailable rather than inventing a source.

- [ ] **Step 6: Implement proper reachability and safe blob resolution.**

  Reject `A === T`. Run `merge-base --is-ancestor A T`; exit 0 is the only positive reachability result, exit 1 is a non-ancestor candidate, and other failures become typed unavailable outcomes. Resolve each path through `ls-tree -z --full-tree <object-id> -- <path>`, require one blob entry, then read it with `cat-file blob <blob-id>`. Decode complete UTF-8 text without stripping carriage returns or normalizing content; NUL/binary or missing required objects becomes unavailable.

- [ ] **Step 7: Implement proof gating and transition classification.**

  Pass the `T:P` and `A:sourcePath` lines plus `blame.finalLine`/candidate `originalLine` to the pure proof. Return uncertain `insufficient-distinctive-context` when movement was suggested but thresholds fail, and uncertain `candidate-not-exact` for line/content mismatch or failed proper reachability. After proof success, select `renamed-path` only for a connected explicit rename, `same-file-move` for the same path with a changed line, `cross-file-move-or-copy` for a different path without connected rename, and `unclassified-exact` otherwise.

- [ ] **Step 8: Run the focused Git ancestry fixtures green and audit recorded argv.**

  Run:

  ```bash
  npm run build && node --test dist/test/git-ancestry.test.js
  ```

  Assert the recorder sees one movement-aware blame with one `-M` and one `-C`, no baseline blame argument changes, only read-only command families, no network/mutating command, and no revision/path concatenation in object access.

---

### Task 3: Provenance/report integration and Codex independence

**Files:**
- Modify: `src/provenance/model.ts`
- Modify: `src/provenance/explain-location.ts`
- Modify: `test/provenance-correlation-flow.test.ts`
- Modify: `test/correlation-e2e.test.ts`
- Modify: `test/git-provenance.test.ts`

**Interfaces:**
- `WhylineReport` gains `ancestry?: GitAncestryResult`; uncommitted/untracked reports omit it because ancestry is not run.
- `analyzeLocation` assembles committed baseline provenance first, then runs ancestry and Codex correlation independently before the existing final stability verification.

- [ ] **Step 1: Add failing report integration tests.**

  Assert committed reports include ancestry, untracked and uncommitted reports make no ancestry Git call, and a hook observing the report sees both independent domains. Add a synthetic Codex decision-table assertion for matched, ambiguous, none, unavailable, and limited coverage alongside exact/uncertain ancestry to prove the correlation result remains unchanged.

- [ ] **Step 2: Run the focused integration tests and confirm the expected failures.**

  Run:

  ```bash
  npm run build && node --test dist/test/provenance-correlation-flow.test.js dist/test/correlation-e2e.test.js
  ```

  Expected: new ancestry assertions fail because the report field and orchestration are not yet integrated; existing correlation failures must not be masked.

- [ ] **Step 3: Extend the report model and assemble ancestry after baseline provenance.**

  Add the optional ancestry field. In the committed branch of `analyzeLocation`, build the unchanged correlation target, then use `Promise.all` to invoke `traceLineAncestry` and `correlateCodex` independently. Do not invoke ancestry in either untracked or uncommitted branches. Preserve the existing final hook and stability checks after the report is assembled.

- [ ] **Step 4: Run focused integration tests green.**

  Run:

  ```bash
  npm run build && node --test dist/test/provenance-correlation-flow.test.js dist/test/correlation-e2e.test.js dist/test/git-provenance.test.js
  ```

  Expected: ancestry appears only where committed baseline provenance exists, all Codex decision-table assertions remain unchanged, and mutation/read-only tests still pass.

---

### Task 4: Explanation-first CLI and bounded renderers

**Files:**
- Create: `src/cli/parse-arguments.ts`
- Create: `src/cli/render-summary.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/render-text.ts`
- Modify: `src/cli/render-correlation.ts`
- Create: `test/cli.test.ts` if no suitable existing file owns argument tests
- Create: `test/explanation-render.test.ts`
- Modify: `test/correlation-render.test.ts`
- Modify: `test/correlation-e2e.test.ts`

**Interfaces:**
- `parseArguments(argv): { readonly details: boolean; readonly location: string }` accepts one location or `--details` followed by one location and throws the existing usage/input error for unknown, repeated, misplaced, or missing arguments.
- `renderSummary(report): string` emits concise outcome-first output.
- `renderDetails(report): string` retains the existing forensic report and adds ancestry evidence.
- `renderText(report, options?: { readonly details?: boolean }): string` dispatches to summary by default and details when requested; `renderCorrelation` remains available for details while a bounded summary helper provides default AI provenance wording.

- [ ] **Step 1: Add failing parser and renderer tests.**

  Cover default and details parsing, unknown/repeated flags with exit code 2 through `runCli`, exact/none/uncertain/unavailable ancestry summaries, uncommitted output, Codex matched/ambiguous/none/unavailable/limited coverage summaries, details candidate/proof/limitations, absence of origin language, no transcript leakage, and bounded output for long values.

- [ ] **Step 2: Run focused CLI/render tests to establish red.**

  Run:

  ```bash
  npm run build && node --test dist/test/cli.test.js dist/test/explanation-render.test.js dist/test/correlation-render.test.js
  ```

  Expected: tests fail because the parser and summary/details separation are not implemented. Existing details assertions should be updated only where they intentionally move behind `--details`.

- [ ] **Step 3: Implement strict argument parsing and CLI dispatch.**

  Accept `whyline <file>:<line>` and `whyline --details <file>:<line>`. Keep a single-dash-leading filename usable as a location, but reject unsupported double-dash flags, repeated `--details`, wrong ordering, and missing location with exit code 2 before repository analysis. Pass the parsed mode to the renderer.

- [ ] **Step 4: Implement concise summary rendering.**

  Render the repository-relative location, `Explanation`, textual last-touch commit short ID and sanitized subject, Git ancestry outcome, and bounded Codex provenance for the textual commit. Exact output includes source path/line, earlier attribution, and transition; no-proof output says only that ancestry was not established; uncertain output says Git suggested movement but exact verification was insufficient. Never emit “originated here,” “original commit,” or equivalent semantic-origin language.

- [ ] **Step 5: Preserve forensic details behind `--details`.**

  Move the existing state, full commit metadata, parent, changed paths, relevant hunk, limitations, and detailed Codex evidence/coverage into the details renderer without exposing raw transcript material. Add ancestry candidate, verified ancestor, transition, proof counts, and ancestry limitations. Keep all existing sanitization and rendering bounds.

- [ ] **Step 6: Run focused CLI/render tests green.**

  Run:

  ```bash
  npm run build && node --test dist/test/cli.test.js dist/test/explanation-render.test.js dist/test/correlation-render.test.js dist/test/correlation-e2e.test.js
  ```

  Expected: concise default output is outcome-first, forensic data appears in details mode, flags map to exit code 2, and privacy-safe Codex behavior remains intact.

---

### Task 5: Documentation and bounded milestone acceptance

**Files:**
- Modify: `docs/whyline-v0-architecture.md`
- Modify: `test/git-ancestry.test.ts` or add `test/ancestry-acceptance.test.ts` for the disposable end-to-end scenario

- [ ] **Step 1: Add failing documentation/acceptance assertions where useful.**

  Extend the disposable real-Git fixture to run the built CLI against one moved distinctive block. Capture both default and `--details` output and assert the refactor commit is textual last-touch, the older commit is the exact ancestor, the transition is rendered, and details include candidate/proof evidence.

- [ ] **Step 2: Update architecture documentation.**

  Document the three independent evidence domains, exact proof requirements, absence-not-origin rule, conservative root/shallow/missing-object/merge behavior, `--details`, and explicit deferral of JSON/ranges/symbols/fuzzy ancestry. State that `-M -C` is candidate generation only.

- [ ] **Step 3: Run the disposable acceptance scenario.**

  Run the focused built test containing only the required real-Git move scenario and record its passing output for the final report. Do not add remote or network setup.

- [ ] **Step 4: Perform the bounded final verification sequence once.**

  Run exactly:

  ```bash
  npm run check
  git diff --check
  npm run build && node --test dist/test/ancestry-acceptance.test.js
  git diff --stat && git diff -- src/ancestry src/git/trace-line-ancestry.ts src/provenance src/cli test docs/whyline-v0-architecture.md
  ```

  Read the full check output, count tests and failures, inspect the bounded diff against every frozen safety/correlation/privacy/CLI criterion, then record any non-blocking observations without opening another review loop.

- [ ] **Step 5: Commit the completed implementation.**

  After the acceptance sequence is green and `git status --short` contains only intended implementation files, create one coherent local implementation commit:

  ```bash
  git add src test docs/whyline-v0-architecture.md
  git commit -m "feat: add exact Git-visible ancestry"
  ```

  Do not merge, push, or open a PR.
