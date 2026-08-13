# Real-repository provenance-pipeline validation

> **Historical record:** This validation report is superseded by later correlation hardening and subsequent release-readiness work. Its findings are preserved as historical evidence and are not the current v0.1.0 release acceptance record.

**Date:** 2026-08-09
**Scope:** read-only validation of Git textual attribution → local Codex
history discovery → conservative correlation → sanitized explanation.
**Code baseline:** `origin/main` `a741a2de248092579857e2b0678950cebbb6eebc`
(the checked-out feature tip has the identical tree; see repository state below).

## Method and safety

- No target repository, Git history, or Codex history was changed.
- No network access was used for correlation. No transcript command was run.
- Transcript inspection was limited to the implemented structured adapter. This
  report records only aggregate counts, fixed renderer text, Git facts, and
  normalized signal/coverage categories; it contains no prompt, reasoning,
  command, output, raw patch, absolute transcript path, or session ID.
- The packaged CLI and internal structured report were exercised against real
  retained local rollout data. The full synthetic suite was also run.

## Starting state

The worktree was clean, but not checked out at `main`:

| Item | Observed value | Assessment |
| --- | --- | --- |
| Worktree branch/tip | `feat/conservative-correlation` / `65a8d47` | Clean, but divergent from `origin/main` history. |
| `origin/main` | `a741a2d` | Matches the supplied squash-merge commit. |
| Tree comparison | `git diff --quiet a741a2d 65a8d47` exited 0 | The checked-out tree is identical to the merged tree, so read-only CLI validation exercised the accepted implementation. |
| Ancestry | `origin/main` is not an ancestor of `65a8d47` | This is a real squash-shaped history, but v0 has no revision-qualified input, so the squash commit itself could not be queried without changing worktrees. |

`npm test` passed: **121 tests, 0 failures**.

## Real history inventory

The effective local store had 289 readable active rollout JSONL files (about
389 MiB); no archive directory was present. All 289 yielded structured session
metadata. The aggregate contained 85 partial sessions, 86 subagent sessions,
125 unknown-record diagnostics, 114 compaction/context-compaction diagnostics,
29 abort diagnostics, and 5 rollback diagnostics.

| Repository | Sessions with structured cwd under the repository | Partial | Subagent | Notes |
| --- | ---: | ---: | ---: | --- |
| Whyline | 55 | 9 | 47 | Candidate count exceeds v0's 32 full-evidence cap. |
| HorizonRadio | 36 | 6 | 32 | Candidate count also exceeds the cap. |
| Axiom | 7 | 5 | 1 | Below the cap, but partial/active coverage remains material. |
| ProtonDoctor | 2 | 2 | 0 | Retained coverage is partial. |
| RouteDoc | 7 | 4 | 0 | Retained coverage is partial. |
| DevSpace | 25 | 9 | 0 | Below cap. |
| DungeonCrawlerWebApp | 10 | 4 | 0 | Below cap. |
| Chess-Web-Game | 0 | 0 | 0 | No retained session with structured cwd under the repository. |

The currently listed Whyline worktree had no linked worktrees, and no nested
Git repositories were found beneath the inspected project roots. The local
history preflight also has no archived or standalone `codex exec` sample.

## Validation matrix

| Scenario / target | Expected qualitative outcome | Actual | Important normalized signals or limitations | Correct? / classification |
| --- | --- | --- | --- | --- |
| Whyline `src/cli/render-correlation.ts:1` (commit `0e5da305`) | A real Codex session-head context exists, but `session-head` alone must not cause attribution. If structured overlap is recoverable and coverage complete, match; otherwise `none`. | `none` | 55 eligible sessions; 32 fully extracted; 23 omitted; `unresolved-repository-candidate`, `candidate-cap`, `changed-during-read`, and `summary-coverage`. | Correct conservative result. This is a **candidate-cap/coverage limitation**, not a false positive. |
| Whyline `src/correlation/correlate.ts:1`, `:100`, and `:115` (commit `9c91866d`) | Same: observed session-head context is supporting only; no match without qualifying structured patch overlap and complete coverage. | `none` for each | 55 eligible / 32 extracted / 23 omitted. Structured result had no visible plausible/strong candidate or signals. | Correct **missing structured evidence** plus material coverage. This validates that a matching session HEAD does not become a causal claim. |
| Axiom `README.md:1` (commit `ae083161`) | Conservative `none` unless a unique complete structured-patch correlation is available. | `none` | 7 local candidates, no cap; three session-head contexts equal the target commit, two of those partial. Renderer reported unresolved repository, changed-during-read, summary coverage, and compaction limitations. | Correct **partial/active transcript coverage** behavior. It is not evidence of human authorship. |
| HorizonRadio `gradle.properties:1` (root commit `245507d`) | No causal claim absent unique, complete patch evidence; root-commit Git facts must still render. | `none` | 36 repository candidates; global coverage included unresolved candidates, cap, active-read change, and summary coverage. Git report correctly used the empty-tree parent. | Correct **conservative none**; no false-positive session selection. |
| Subagent/root overlap (Whyline aggregate) | Separate sessions must not be flattened or selected from timing/path coincidence. | No selected session | 47 of 55 Whyline sessions were structured subagents; all remained individual candidates and cap coverage blocked uniqueness. | Correct **intentional ambiguity protection**. Full subagent-vs-root resolution could not be validated because the candidate cap prevented exhaustive evidence inspection. |
| Candidate cap on retained history | Omitted eligible sessions must be visible and must block `matched`. | Observed exactly: 55 eligible, 32 fully extracted, 23 omitted; status `none`. | `candidate-cap` is material and renderer states bounded inspection. | Correct **deliberate v0 limitation**. |
| Concurrent/transcript mutation | An actively appended selected transcript must not yield a causal match. | `none` | `changed-during-read` material limitation appeared in every real interactive run. | Correct **intentional safety behavior**. |
| Renderer privacy/usefulness | It must provide useful status/coverage without transcript material. | All outputs rendered Git facts plus bounded fixed Codex status/coverage text; no raw transcript material was emitted. | Candidate IDs were not rendered because no candidate survived as plausible/strong. Existing privacy renderer tests also passed. | Correct for privacy; usefulness is limited by the repeated `none` result. |
| Store availability/corruption | Readable store with recognized records should not report unavailable. | `none`, never `unavailable` | 289/289 summaries usable; observed partial/compaction/abort/rollback diagnostics. | Correct **available but limited** behavior. |

### Scenarios not available locally without mutation

- A real linked worktree, deleted/relocated worktree, nested repository during a
  session, archive rollout, and standalone `codex exec` transcript were absent.
- The repository contains a real squash-shaped merge (`a741a2d` and `65a8d47`
  share a tree but not ancestry), but v0 addresses only the current worktree;
  testing that historical commit would require a worktree change or a new
  worktree, both outside this read-only investigation.
- Real rebased/amended final commits and a known human-final-edit case could not
  be identified from safe structured evidence alone. The existing synthetic
  fixtures cover their deterministic decision rules, but they remain unvalidated
  against a consented retained real session.

## Performance

Observed end-to-end elapsed times were 7–22 seconds (Whyline: 20–22 seconds;
Axiom: 9 seconds; HorizonRadio: 7 seconds). A structured Whyline invocation
reported 9.9 seconds for 289 discovered references, 55 eligible summaries, and
32 full-evidence parses. This misses the architecture document's *proposed*
warm-cache target of under two seconds; it is a hardening concern, not a causal
matching defect. The current summary pass streams every transcript to retain
working-directory/observed-through context, so the cost grows with the entire
389 MiB retained store even before bounded full extraction.

## Findings

1. **No false causal explanation was emitted.** Session HEAD equality, close
   time, shared cwd, and subagent ancestry did not independently produce a
   match. This is the primary invariant working as designed.
2. **The real profile did not yield a `matched` or `ambiguous` case.** Therefore
   actual positive correlation is not yet empirically validated, despite the
   synthetic positive corpus passing.
3. **Candidate-cap behavior is functioning as specified but prevents wider
   usefulness in agent-heavy repositories.** For Whyline, 23 candidates are
   uninspected; returning `matched` would be unsafe.
4. **Active-session mutation is correctly fail-closed but frequently encountered
   during interactive use.** A live Codex rollout can make the entire conclusion
   limited. This is expected from the documented concurrency rule.
5. **Partial/compacted sessions are prevalent.** They are correctly represented
   as coverage loss, not treated as absent evidence.
6. **There is no confirmed implementation defect from the safe real-data
   observations.** The surprising results are either deliberate conservative
   behavior, missing qualifying structured patch evidence, or unavailable local
   scenario shapes. Accordingly, no private-data-derived regression fixture is
   required. The existing synthetic fixtures already exercise the corresponding
   cap, changed-during-read, compaction, subagent, rebase/amend, linked-worktree,
   nested-repository, and squash decision branches.

## Recommendation

**Do not declare v0 ready for broader use yet.** It is safe in this retained
profile, but it has not demonstrated a real positive match and is too slow for
the proposed interactive latency goal.

Before another capability or semantic ancestry planning, complete a narrowly
scoped hardening phase:

1. Add privacy-safe operational telemetry to the structured report/test seam:
   candidate counts by eligibility/repository classification, summary bytes/read
   time, evidence bytes/read time, and the precise material limitation source.
   Do not render transcript data.
2. Establish a consented, redacted real-session validation corpus that includes
   at least one unique successful `apply_patch` overlap resulting in a commit,
   one legitimate ambiguity, an amended/rebased commit, a human-final-edit case,
   and a deleted/linked worktree case. Derive synthetic fixtures from each before
   a fix is proposed.
3. Profile and redesign summary discovery so it can safely avoid full-file scans
   where the required summary facts are already established, or explicitly
   measure and accept the cost. Any optimization must retain cwd-change,
   observed-through, and concurrent-read safety diagnostics.
4. Re-evaluate bounded extraction only through sound coverage methods. Do not
   raise confidence or lower the two-distinctive-line threshold to improve recall;
   a cap must continue to block a causal claim whenever omitted candidates could
   be strong.

These are hardening/validation tasks, not semantic ancestry. **Semantic ancestry
should remain deferred** until the above produces at least one real positive,
one real ambiguity, and a latency decision with privacy-safe regression
coverage.
