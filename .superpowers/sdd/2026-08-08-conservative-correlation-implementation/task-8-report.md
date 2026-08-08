# Task 8 report: final documentation and release verification

## Scope and status

The original Task 8 review started at `6ecbf33` on
`feat/conservative-correlation`, using GPT-5.6 Luna Max as required. The
governing specification, implementation plan, preflight, architecture, ledger,
prior task reports, and complete implementation/test set were reviewed.

The correction round started from the Task 8 documentation commit `8819722`
and was limited to the reviewed default-home defect and stale evidence:

- `resolveCodexHome` now gives explicit `codexHome` precedence, then an
  explicitly supplied discovery environment, then the normal process
  `CODEX_HOME`, before falling back to the effective process home's `.codex`.
- The CLI regression creates separate temporary `CODEX_HOME` and ambient
  `$HOME/.codex` profiles. It requires the synthetic-home session marker and
  rejects the ambient-profile marker, proving that a synthetic
  `CODEX_HOME` does not consult the real/ambient profile.
- Explicit analysis `codexHome` context and injected `AgentHistorySource`
  precedence were left unchanged.

The correction changed only `src/agents/codex/discover.ts` and
`test/git-provenance.test.ts` in commit `8a4ca8c`. No Task 6/7 files, plan,
governing specification, preflight, or architecture edits were made in this
correction. No push or pull request was created.

## Documentation decision

The architecture changes made by the original Task 8 documentation commit
remain accurate: they document the narrow injected history-source/history-root
seam, the effective `CODEX_HOME`/process-home behavior, the resolved Git
working-directory boundary, full-evidence repository reclassification, and the
bounded integrated committed-location correlation path.

No additional architecture change was established by this correction. The
plan, governing specification, and preflight remain unchanged.

## Correction-round verification

All evidence in this section was captured after correction commit `8a4ca8c`
and before this report-only refresh commit. The coordinator is responsible for
the final broad verification; it was intentionally not repeated here.

`npm run build`

```text
exit 0
tsc -p tsconfig.json
```

Focused Codex-home, CLI, and precedence invocation:

```text
node --test --test-name-pattern='CLI|discovery is recursive|committed provenance passes|uncommitted lines|untracked lines|agent source exposes' dist/test/git-provenance.test.js dist/test/codex-history.test.js dist/test/provenance-correlation-flow.test.js
```

Result: exit `0`; 10 tests passed, 0 failed, 0 cancelled. This includes the
new `CODEX_HOME` CLI regression, the normal CLI tests, discovery, injected
source/context flow, and uncommitted/untracked no-discovery paths.

Focused privacy, transcript-operation, and renderer invocation:

```text
node --test --test-name-pattern='privacy-sensitive|renderer-safe|exact call IDs|custom exec|absolute patch paths|renders|plausible|ambiguous|does not claim|empty and missing' dist/test/codex-history.test.js dist/test/correlation-e2e.test.js dist/test/correlation-render.test.js
```

Result: exit `0`; 11 tests passed, 0 failed, 0 cancelled. No transcript
command was executed, raw command/output/patch/path data was not rendered, and
ambiguous or plausible-only results retained their conservative status.

`npm pack --dry-run --json` passed with the following exact package summary:

```text
npm warn gitignore-fallback No .npmignore file found, using .gitignore for file exclusion. Consider creating a .npmignore file to explicitly control published files.
id: whyline@0.1.0
filename: whyline-0.1.0.tgz
size: 249477
unpackedSize: 1224842
shasum: 06be08899b9bb618b171d8f96b0691487fa03700
entryCount: 119
exit 0
```

`git diff --check && git show --check --oneline HEAD` passed with exit `0` and
reported:

```text
8a4ca8c fix: honor CODEX_HOME in default discovery
```

## Operational audits

The required broad audit invocation was run exactly as follows:

```text
rg -n "exec\(|spawn\(|shell:|history\.jsonl|~/.codex|remote|fetch|confidence|%" src test
```

It exited `0` with 31 matching lines. Review of all matches found only the
argv Git `spawn` boundary with `shell: false`, Git format/regex syntax,
`history.jsonl` exclusion and tests, internal confidence-band/scoring names,
and test-only forbidden-command guards. No transcript content is executed or
shell-parsed.

Focused renderer score/probability audit:

```text
rg -n -i "score|probabil|confidence|percent|%" src/cli
```

It exited `1` with no matches. The CLI renderer therefore exposes no scores,
confidence values, probabilities, or percentages.

Focused persistence audit:

```text
rg -n -i "sqlite|sqlite3|better-sqlite|appendFile|createWriteStream|writeFile|cache|index\.db" src
```

It exited `1` with no matches. Runtime source has no SQLite, persistent cache,
or index write path.

Focused effective-home audit:

```text
rg -n -i "os\.homedir|CODEX_HOME|/\.codex|~/.codex" src test
```

It exited `0` with 8 matches, all limited to the process-home/CODEX_HOME
resolver and temporary synthetic-home fixtures. No literal real profile path
is used by tests.

Focused production network/remote-Git audits:

```text
rg -n -i 'file://|https?://' src
rg -n -i 'git (fetch|push|pull|clone|remote)' src
```

Both exited `1` with no matches. The only static transport hits in tests are
the local `file://` shallow-clone fixture and synthetic URL/remote-leakage
sentinels; the analysis runner's read-only Git allowlist rejects clone,
fetch, push, and remote operations.

Focused child-process audit:

```text
rg -n 'spawn\(|shell:' src/git src/agents src/cli src/provenance
```

It exited `0` with only the Git runner's `spawn` call and explicit
`shell: false`. Codex transcript `exec` and `custom exec` records remain
opaque evidence attempts and never enter this process boundary.

Tests use temporary synthetic Codex homes or injected sources. The new CLI
test specifically places an ambient marker under a temporary `$HOME/.codex`
and asserts that only the `CODEX_HOME` marker is rendered; it never opens the
real `/home/benjamin/.codex` profile.

## Coverage findings

The current focused runs verify the load-bearing correction and the adjacent
operational boundaries. The existing implementation/test set continues to
cover conservative repository compatibility, structured patch-side matching,
ambiguous and plausible-only outcomes, bounded rendering, partial/changed
transcripts, and Git-only behavior for uncommitted or untracked targets. The
correction did not alter those correlation rules.

The full suite and whole-branch review are intentionally deferred to the
coordinator's one final verification pass. No unrelated production behavior or
Task 6/7 work was started.

Known v0 limitations remain unchanged: the adapter emits session-head context
rather than a produced-commit claim; transcript parsing is bounded to the
observed rollout envelope; missing or relocated repository context can remain
unknown; and incomplete evidence lowers coverage instead of supporting a
causal claim.

## Git handoff

The exact Git summaries below were captured after correction commit `8a4ca8c`
and before this report-only refresh commit. This evidence boundary is stated
explicitly because committing this report necessarily advances `HEAD`; the
package and audit results above describe the corrected implementation commit,
not an unrun post-report full suite.

`git log --oneline --decorate -n 15`

```text
8a4ca8c (HEAD -> feat/conservative-correlation) fix: honor CODEX_HOME in default discovery
8819722 docs: record integrated correlation behavior
6ecbf33 test: close Task 7 e2e review gaps
8f2c394 test: cover staged Git Codex correlation
0e5da30 fix: harden bounded Codex correlation rendering
a4219e7 feat: render bounded Codex correlation evidence
67adfc1 fix: reject ambiguous cwd-less correlation evidence
5fecd83 fix: reclassify full Codex evidence repositories
3902177 fix: close Task 5 path and repository gaps
66427c8 fix: close Task 5 correlation coverage gaps
4760e68 fix: propagate candidate coverage limitations
13b8615 fix: preserve prunable worktree correlation
8db8ba4 fix: harden staged Codex correlation
46d0f23 feat: stage Codex correlation from Git provenance
a3bd854 fix: derive limited coverage status
```

`git diff --stat main...HEAD`

```text
33 files changed, 8413 insertions(+), 57 deletions(-)
```

The complete stat listed only the existing Task 5–8 documentation/spec/plan
artifacts, correlation implementation/tests, and the intended correction
files; no unrelated production area was changed.

`git status --short`

```text
(empty)
```

The remote-tracking ref was
`origin/feat/conservative-correlation` at `004fb494be84b154a8909e4dbda2f69222271420`.
At the evidence boundary the local branch was ahead by 26 commits. No push or
pull request was created.

## Final fixer wave: exact linkage and anchored historical projection

This final scoped wave started from `e2cd106` on
`feat/conservative-correlation` and addressed the two load-bearing whole-branch
review findings together.

- Exact `patch_apply_end` linkage now controls `resultRecorded`. A missing,
  unknown, or non-patch call ID still retains a normalized structured patch
  result when an ID is present, but it is not a recorded patch completion and
  cannot enter successful patch scoring. The adapter keeps the unlinked-result
  diagnostic and maps it to material summary coverage. No linkage is inferred
  from command text, shell output, prompts, or other arbitrary transcript text.
- Unknown or deleted historical cwd projection now has one bounded escape hatch:
  a uniquely resolved target commit reference, unknown repository context in
  both summary and full evidence, and normalized structured patch changes. Only
  exact Git-derived target/blame/rename path aliases are projected; basenames,
  arbitrary relative paths, commands, prompts, and raw text do not establish
  repository identity. Mixed known/unknown context and unanchored candidates
  retain the prior filtering and coverage behavior.
- Regressions cover adapter linkage and diagnostic retention, an actual
  `CodexHistorySource` orphaned two-distinctive-line patch that cannot become
  strong, matched, or “Likely,” an anchored arbitrary unregistered cwd, the
  no-anchor negative, and basename-only path rejection.

Focused verification after the source/test changes:

```text
npm run build
exit 0

node --test dist/test/codex-history.test.js dist/test/correlation-patch.test.js dist/test/correlation-decision-table.test.js dist/test/provenance-correlation-target.test.js dist/test/provenance-correlation-flow.test.js dist/test/correlation-e2e.test.js dist/test/git-provenance.test.js
exit 0; 107 passed, 0 failed, 0 cancelled
```

The single self-review found six scoped source/test files changed plus this
report, with no renderer or unrelated Task 1–4 redesign. The broad full
verification remains intentionally deferred to the coordinator's one final
pass.
