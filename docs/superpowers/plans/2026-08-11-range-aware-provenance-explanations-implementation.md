# Range-Aware Provenance Explanations Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Goal: Add inclusive range queries that preserve line-level textual attribution, conservatively covered exact ancestry, projected Codex outcomes, uncommitted state, and explicit work bounds without changing single-line behavior.

Architecture: Keep the existing single-line parser, resolver, coordinator, ancestry tracer, correlation decision table, and renderers compatible. Add a range-native resolver, one-command porcelain blame parser, grouped/batched Git inspection, a span-based ancestry tracer, and a dedicated range coordinator. Split Codex correlation at a preparation/projection seam so transcript discovery and scanning happen once while each textual group receives unchanged correlation semantics.

Tech Stack: TypeScript 5.9, Node.js 24, ESM, built-in node:test, existing GitRunner/GitProcess, argv-only local read-only Git, no runtime dependencies.

## Global Constraints

- Range endpoints are positive, ordered, inclusive, at most 200 lines, and both endpoints must exist in the current UTF-8 text file.
- Existing single-line behavior and callers remain compatible; do not turn every single-line type into a range union.
- Baseline range attribution uses exactly one git blame --line-porcelain -L START,END -- PATH invocation and preserves one fact per queried line.
- Textual group identity includes state, textual commit, blamed path, and selected parent evidence; non-contiguous spans retain separate rendered spans.
- Exact ancestry claims cover only queried lines inside independently successful exact proof blocks; the existing 32-line proof window and thresholds remain unchanged.
- Deep ancestry/Codex analysis is limited to the first 24 committed textual groups in source order; skipped groups are work-bound/unavailable, never none.
- Codex scan/discovery and all source-mutation gates are invocation-global for range preparation; target projection reuses normalized evidence and preserves thresholds, caps, ambiguity, coverage, and privacy semantics.
- Uncommitted groups receive no ancestry or Codex attribution and render not run.
- Git remains local, offline, argv-only, read-only, and shell-free; no commands from transcripts execute.
- Summary renders at most 12 groups per section; details renders at most 64 and reports exact omitted counts plus a narrower-range hint.
- No JSON, symbols, transformed/fuzzy/structural ancestry, persistent cache/index, new agent adapters, remote metadata, or generic provenance framework.

---

### Task 1: Range query parsing and one-read resolution

Files:
- Modify: src/location/parse-location.ts
- Modify: src/location/resolve-location.ts
- Modify: src/provenance/model.ts
- Modify: src/cli/parse-arguments.ts
- Test: test/cli.test.ts
- Create: test/location-range.test.ts

Interfaces:
- Add LocationQuery = LineLocationQuery | RangeLocationQuery and parseLocationQuery(input): LocationQuery while keeping parseLocation(input): ParsedLocation for existing single-line callers.
- Add ResolvedRangeCodeLocation containing the original query, canonical path, repository path, start/end lines, bounded queried line contents/digests, one FileSnapshot, target state, and dirty flag.
- Add resolveRangeLocation(query, context, runner, currentDirectory): Promise<ResolvedRangeCodeLocation>; it resolves and reads the file exactly once.
- parseArguments continues returning { details, location }; validation delegates to the location parser so double-dash-leading range paths remain locations.

- [ ] Step 1: Add failing parser tests for valid inclusive ranges, same-line ranges, the existing single-line form, reversed ranges, zero/negative endpoints, a 201-line range, missing endpoint syntax, and an endpoint beyond EOF. Assert InvalidInputError with exit code 2 where applicable.
- [ ] Step 2: Add parser cases for spaces, Unicode, colons, -leading.ts:1-2, and --generated.ts:1-2. Assert the final colon is authoritative and the filename remains unchanged.
- [ ] Step 3: Run the focused tests red:

      npm run build && node --test dist/test/location-range.test.js dist/test/cli.test.js

  Expected: the new range imports or assertions fail while existing single-line cases continue to identify their current behavior.
- [ ] Step 4: Implement parseLocationQuery by parsing the final colon, then either one positive integer or two positive integers separated by one hyphen. Reject empty, non-numeric, reversed, zero, unsafe, and over-200 ranges. Keep parseLocation as a line-only adapter with its current return shape.
- [ ] Step 5: Add a resolver test using a temporary Git fixture with a UTF-8 file, Unicode content, and a path containing spaces/colons. Implement resolveRangeLocation by sharing only the existing canonical-path, snapshot, and decode helpers; read bytes once, validate both endpoints, and call readTargetStatus once.
- [ ] Step 6: Make CLI validation use parseLocationQuery, preserving --details ordering, unknown/repeated flags, single-dash filenames, and double-dash filenames. Run:

      npm run build && node --test dist/test/location-range.test.js dist/test/cli.test.js
- [ ] Step 7: Commit:

      git add src/location src/provenance/model.ts src/cli/parse-arguments.ts test/location-range.test.ts test/cli.test.ts
      git commit -m "feat: parse and resolve line ranges"

---

### Task 2: One-command range blame and textual grouping

Files:
- Create: src/git/blame-range.ts
- Create: src/provenance/range-model.ts
- Modify: src/git/blame-line.ts only to share bounded porcelain helpers if required
- Modify: src/git/inspect-commit.ts with range inspection helpers
- Test: test/git-blame-range.test.ts
- Create: test/range-grouping.test.ts

Interfaces:
- Add parseBlamePorcelainRange(value, fallbackPath, startLine, endLine): readonly RangeLineAttribution[] and blameRange(runner, context, repositoryPath, startLine, endLine): Promise<readonly RangeLineAttribution[]>.
- Add RangeLineSpan, RangeLineAttribution, RangeTextualGroup, RangeAncestrySegment, RangeAncestryCoverage, RangeCorrelationGroup, RangeAnalysisCoverage, and WhylineRangeReport in src/provenance/range-model.ts.
- Add a range group builder that receives all line facts, one commit metadata cache, one parent-selection key per fact, and one commit/parent inspection cache; it returns ordered groups plus line-to-group membership.
- Add inspectCommitRangeGroup or equivalent that runs each needed commit/parent diff once and returns bounded metadata, changed paths, relevant hunks, and limitations.

- [ ] Step 1: Add parser tests for two committed records, a zero-object line, Unicode filename, previous path, and tabbed line content. Assert exactly one fact per requested line and correct final-line mapping.
- [ ] Step 2: Add malformed parser tests for empty output, malformed headers, missing tab content, invalid numeric fields, duplicate lines, and missing lines. Assert OperationalError rather than partial success.
- [ ] Step 3: Run red:

      npm run build && node --test dist/test/git-blame-range.test.js

- [ ] Step 4: Implement sequential porcelain parsing from each header through its tabbed line content. Require one record per requested final line. Invoke Git with existing fixed config, blame --line-porcelain -L START,END -- PATH, and separate -- argv. Never call blameLine.
- [ ] Step 5: Add grouping tests for contiguous and non-contiguous equivalent facts, mixed commits, mixed paths, different parent selections, and zero-object facts. Assert all original line facts remain available after grouping.
- [ ] Step 6: Add an inspection test with repeated commit IDs and assert metadata calls are deduplicated by commit ID and diffs by commit/parent/path evidence. Include rename evidence and unresolved merge parents.
- [ ] Step 7: Implement deterministic grouping keys containing state, commit ID, blamed path, and serialized parent selection including ambiguous/unavailable variants. Sort by first queried line and derive spans without merging unequal keys.
- [ ] Step 8: Implement batched commit inspection using selectParent for every fact, cached commit metadata, and one changed-path/relevant-diff operation per group. Preserve existing rename and merge limitations; never infer a merge parent.
- [ ] Step 9: Run:

      npm run build && node --test dist/test/git-blame-range.test.js dist/test/range-grouping.test.js

  Commit:

      git add src/git/blame-range.ts src/git/inspect-commit.ts src/provenance/range-model.ts test/git-blame-range.test.ts test/range-grouping.test.ts
      git commit -m "feat: add range blame and textual grouping"

---

### Task 3: Range exact ancestry with line coverage

Files:
- Create: src/git/trace-range-ancestry.ts
- Modify: src/ancestry/model.ts only if shared proof metadata needs a range-safe exported type
- Test: test/range-ancestry.test.ts

Interfaces:
- Add traceRangeGroupAncestry(runner, context, location, group): Promise<RangeAncestryCoverage>.
- Range coverage contains ordered segments with span, status exact/uncertain/none/unavailable/not-run/work-bound, optional candidate/ancestor/proof metadata, and bounded limitations.
- The tracer consumes RangeTextualGroup and reuses parseBlamePorcelain, proveExactBlock, and existing Git path/object safety rules.

- [ ] Step 1: Add failing real-Git tests for a range containing a distinctive moved block and neighboring lines. Assert the moved block can become exact while unproven lines remain non-exact.
- [ ] Step 2: Add a 64-line moved block and assert multiple proof windows are used while the unchanged 32-line proof bound remains visible in each proof.
- [ ] Step 3: Add candidate-run tests for two candidate commits/paths, repeated/generic context, whitespace-only transformation, and partial transformation. Assert no line outside successful proof coverage is exact.
- [ ] Step 4: Add root, shallow, missing object, malformed blame, process failure, ambiguous parent, Unicode path, and rename fixtures. Assert typed unavailable/uncertain outcomes and conservative root semantics.
- [ ] Step 5: Run red:

      npm run build && node --test dist/test/range-ancestry.test.js

- [ ] Step 6: Implement one span-level movement-aware blame query per group/source span using textual source line bounds. Map returned final lines to source facts and partition runs by candidate commit/path and adjacent line progression; never query each line.
- [ ] Step 7: Cache reachability by candidate/textual commit pair, blob material by commit/path, and subject by commit. Resolve blobs through ls-tree -z --full-tree OBJECT -- PATH then cat-file blob BLOB. Decode complete UTF-8 with no whitespace/case normalization.
- [ ] Step 8: Require proper reachable ancestry and unchanged proveExactBlock thresholds. Union successful proof coverage, initialize analyzed lines as none, mark candidate-run lines uncertain when proof fails, and replace only successful queried intersections with exact. Preserve unavailable limitations and derive contiguous differing segments.
- [ ] Step 9: Run:

      npm run build && node --test dist/test/range-ancestry.test.js dist/test/ancestry-proof.test.js

  Commit:

      git add src/git/trace-range-ancestry.ts src/ancestry/model.ts test/range-ancestry.test.ts
      git commit -m "feat: trace exact ancestry across ranges"

---

### Task 4: Codex scan-once/project-many seam

Files:
- Modify: src/provenance/correlate-codex.ts
- Modify: src/agents/agent-history-source.ts only if a prepared internal type needs export
- Create: test/codex-range-projection.test.ts
- Modify: test/correlation-decision-table.test.ts only for equivalence fixtures
- Modify: test/correlation-e2e.test.ts only for regression assertions

Interfaces:
- Add PreparedCodexEvidence containing discovery, scanned normalized evidence, reusable repository assessments, global coverage limitations, work limits, and invocation-local Git state.
- Add prepareCodexEvidence(options without target-specific target): Promise<PreparedCodexEvidence>; it discovers opening/closing once and scans each ref once without a target-dependent rescan.
- Add projectPreparedCodex(prepared, target, location): Promise<CorrelationResult>; it resolves target-specific references/aliases, projects evidence, and invokes unchanged candidate/scoring/correlator functions.
- Keep correlateCodex public options and result unchanged; route it through the seam only if equivalence is demonstrated, otherwise leave its current single-line path intact.

- [ ] Step 1: Add a counting source and failing harness for two targets over one scan. Cover matched, ambiguous, none, unavailable, limited, candidate cap, source mutation, and different projection results.
- [ ] Step 2: Run red:

      npm run build && node --test dist/test/codex-range-projection.test.js

- [ ] Step 3: Extract target-independent opening/closing discovery, bounded transcript scanning, repository-directory classification, and scan coverage accounting behind prepareCodexEvidence. Preserve MAX_FULL_EVIDENCE_CANDIDATES, pools, source signatures, and limitation kinds.
- [ ] Step 4: Extract target-specific reference resolution, aliases, historical path projection, possibility classification, full-evidence cap, and correlate call behind projectPreparedCodex. Prepared scans remain immutable across targets.
- [ ] Step 5: Assert one discovery opening/closing pair, one scan per transcript, zero transcript rereads, different target results, unchanged thresholds/bands/caps, and privacy-safe outputs.
- [ ] Step 6: Run the complete correlation suite:

      npm run build && node --test dist/test/codex-range-projection.test.js dist/test/correlation-decision-table.test.js dist/test/correlation-e2e.test.js

  Commit:

      git add src/provenance/correlate-codex.ts src/agents/agent-history-source.ts test/codex-range-projection.test.ts test/correlation-decision-table.test.ts test/correlation-e2e.test.ts
      git commit -m "refactor: prepare Codex evidence for target projection"

---

### Task 5: Range coordinator, work bound, and stability gate

Files:
- Create: src/provenance/explain-range.ts
- Modify: src/provenance/range-model.ts
- Modify: src/cli/main.ts
- Create: test/range-provenance-flow.test.ts
- Create: test/range-acceptance.test.ts

Interfaces:
- Add AnalyzeRangeOptions mirroring current directory, Git runner, hooks, agent history source, Codex home, and telemetry injection points.
- Add analyzeRange(input, options): Promise<WhylineRangeReport>.
- Keep analyzeLocation unchanged for single lines; CLI dispatches to range only when parseLocationQuery returns kind range.

- [ ] Step 1: Add a fixture range with two committed groups and one dirty/uncommitted group. Assert line facts, separate groups, independent ancestry/Codex attachment, and no Codex calls for uncommitted lines.
- [ ] Step 2: Add at least 25 committed groups. Assert group 25 keeps baseline attribution and receives work-bound ancestry/Codex outcomes, never none.
- [ ] Step 3: Add file/branch mutation hooks and a counting runner. Assert final mutation is exit code 3 and baseline range blame is exactly one command with no blameLine calls.
- [ ] Step 4: Run red:

      npm run build && node --test dist/test/range-provenance-flow.test.js

- [ ] Step 5: Implement one-read resolve, untracked/uncommitted baseline handling, one blameRange call, grouped/cached inspection, and line-preserving report assembly.
- [ ] Step 6: Assign deep ordinals only to committed groups in source order. Analyze first 24 with range ancestry and prepared Codex projection; mark later groups work-bound and all uncommitted groups not-run.
- [ ] Step 7: Build ordinary CorrelationTarget values from each group and attach exactly one prepared projection result per eligible group. Never merge group outcomes into a range-wide AI claim.
- [ ] Step 8: Recheck HEAD, branch, target snapshot, and target Git status using the existing stability rules after the report hook. Throw OperationalError on any change.
- [ ] Step 9: Run:

      npm run build && node --test dist/test/range-provenance-flow.test.js dist/test/range-acceptance.test.js

  Commit:

      git add src/provenance/explain-range.ts src/provenance/range-model.ts src/cli/main.ts test/range-provenance-flow.test.ts test/range-acceptance.test.ts
      git commit -m "feat: orchestrate range provenance analysis"

---

### Task 6: Bounded range summary/details rendering

Files:
- Create: src/cli/render-range-summary.ts
- Create: src/cli/render-range-details.ts
- Modify: src/cli/main.ts
- Create: test/range-render.test.ts

- [ ] Step 1: Add failing reports for uniform/mixed ranges, partial exact ancestry, ambiguous/limited/unavailable Codex, uncommitted groups, and work-bound groups. Assert separate spans and no range-wide origin claim.
- [ ] Step 2: Add 13 summary groups and 65 details groups. Assert 12/64 limits, exact omitted counts, and a narrower-range instruction. Add control characters/private transcript paths/prompts/reasoning/commands/raw patch-like strings and assert sanitization/privacy.
- [ ] Step 3: Run red:

      npm run build && node --test dist/test/range-render.test.js

- [ ] Step 4: Implement renderRangeSummary(report) with repositoryPath:start-end, Explanation, textual spans, ancestry segments, and Codex outcomes attached only to their textual groups. Collapse only genuinely uniform domains.
- [ ] Step 5: Implement renderRangeDetails(report) with bounded state, line/group facts, commit metadata, parent, paths, hunks, ancestry proof/candidate coverage, Codex candidates/coverage, uncommitted spans, work-bound omissions, and history limitations.
- [ ] Step 6: Dispatch range summary/details in runCli while preserving single-line dispatch and error mapping. Run:

      npm run build && node --test dist/test/range-render.test.js dist/test/cli.test.js dist/test/explanation-render.test.js

- [ ] Step 7: Commit:

      git add src/cli/main.ts src/cli/render-range-summary.ts src/cli/render-range-details.ts test/range-render.test.ts
      git commit -m "feat: render bounded range explanations"

---

### Task 7: Documentation and disposable mixed-range E2E

Files:
- Modify: docs/whyline-v0-architecture.md
- Modify: test/range-acceptance.test.ts

- [ ] Step 1: Create a temporary real Git repository with a distinctive base block, a refactor commit moving it, a separately attributed committed block, and local modified/uncommitted lines. Run the built CLI for one range containing all three.
- [ ] Step 2: Assert summary and details preserve textual groups, exact ancestry only on the moved block, independent Codex domains, no Codex for uncommitted lines, and no range-wide author/origin claim.
- [ ] Step 3: Update architecture documentation with range syntax/bounds, line facts, group keys, one-command blame, 24-group work bounds, Codex preparation/projection, exact proof coverage, mixed rendering, and unchanged single-line/non-goal boundaries.
- [ ] Step 4: Run:

      npm run build && node --test dist/test/range-acceptance.test.js

- [ ] Step 5: Commit:

      git add docs/whyline-v0-architecture.md test/range-acceptance.test.ts
      git commit -m "docs: document range provenance milestone"

---

### Task 8: Single bounded final verification and diff inspection

- [ ] Step 1: Run exactly:

      npm run check
      git diff --check
      npm run build
      node --test dist/test/range-acceptance.test.js

  If npm run check already performs the build and acceptance test, report what actually ran and do not duplicate work.
- [ ] Step 2: Inspect git diff --stat, git status --short, and the focused diff for grouping keys, exact line coverage, Codex equivalence, privacy/read-only behavior, work bounds, CLI bounds, and scope. Do not launch repeated review agents.
- [ ] Step 3: If a concrete load-bearing failure is found, return to that task with a failing regression test, fix it, and rerun the single final sequence. Otherwise leave the coherent local commits in place; do not push, merge, or open a PR.
