# Task 8 report: final documentation and release verification

## Scope and status

Task 8 was reviewed on `feat/conservative-correlation` at starting HEAD
`6ecbf33`, using GPT-5.6 Luna Max as required. The governing specification,
implementation plan, preflight, architecture, ledger, prior task reports, and
the complete implementation/test set were read.

No production behavior was changed. The plan, governing specification, and
preflight remain unchanged. The documentation commit contains only the
architecture corrections below and this report; no push or pull request was
created.

## Documentation decision

`docs/whyline-v0-architecture.md` was updated only for concrete implemented
seams:

- the narrow injected history-source/history-root analysis seam and the absence
  of a general configuration or persistent-history surface;
- the Git runner's resolved subprocess working-directory boundary, rather than
  describing calls as literal `git -C` invocations;
- full-evidence repository reclassification before projection, including the
  rule that incompatible or ambiguous full-bundle context cannot be inherited
  by cwd-less evidence and creates material coverage when relevant evidence is
  dropped;
- the integrated committed-location correlation behavior and its bounded,
  coverage-gated next release-hardening step.

## Verification

Fresh commands completed before the documentation edit:

- `npm run build` — passed.
- Focused adapter/correlation/flow/renderer/E2E command covering 81 tests —
  81 passed, 0 failed.
- `npm run check` — typecheck passed; full suite 110 passed, 0 failed.
- `npm pack --dry-run --json` — passed; 119 files, 246,850-byte package,
  1,214,549-byte unpacked size. npm emitted its non-blocking warning that no
  `.npmignore` exists and `.gitignore` was used.
- `git diff --check` — clean before the documentation edit.

The focused coverage breakdown was: 19 adapter tests, 13 patch-overlap tests,
10 decision-table tests, 1 target-construction test, 18 staged-flow tests, 8
renderer tests, and 12 synthetic end-to-end tests.

## Operational audit

The requested `rg` audit and source/test review found no production path that
executes transcript content, uses a shell, accesses a network, fetches remote
Git data, renders scores, or persists an index/cache/SQLite store.

- The only production child-process boundary is the Git runner. It passes an
  argv array to `spawn` with `shell: false`; transcript `exec`/`custom exec`
  records are retained only as opaque attempts and are never run or parsed as
  shell commands.
- `history.jsonl` is explicitly excluded from discovery and is treated as an
  unsupported prompt index if passed directly. Tests assert that it cannot
  become provenance evidence.
- The renderer accepts only the normalized correlation result, uses closed-kind
  presentation maps, and never renders prompts, reasoning, commands, output,
  patch source, URLs, absolute transcript paths, evidence IDs, scores, or
  probabilities/percentages. Git's separate existing report still renders its
  bounded Git facts and target hunk.
- Tests use temporary synthetic Codex homes or injected sources. No test uses
  the real `~/.codex`; committed Git tests create a fixture-owned synthetic
  home, and uncommitted/untracked flow tests make zero discovery calls.
- Runtime source code has no SQLite, persistent cache, or index writes. Codex
  history is scanned on demand.
- Static remote/transport hits are fixture-only: the shallow-history Git test
  uses a local `file://` clone to construct a temporary repository, while the
  end-to-end analysis runner has an exact read-only allowlist that rejects
  clone/fetch/push/remote commands. Test `execFile` use only launches the built
  CLI and does not execute transcript commands.

## Invariant and coverage findings

The focused and full suites confirm that:

- known repository contradictions are excluded before scoring and cannot be
  outweighed;
- time-only evidence remains weak;
- plausible-only evidence cannot select a session;
- two strong candidates remain ambiguous;
- uncommitted and untracked targets make no discovery call;
- only supported successful structured update/add/delete patch variants can
  produce direct overlap;
- truncated relevant Git hunks block `matched` without inferring divergence;
- candidate caps, unsupported summaries, unavailable/limited stores, partial
  reads, changed-during-read, compaction, and ambiguous cwd-less evidence remain
  visible as typed coverage limitations.

Known v0 limitations remain those in the governing documents: the current
adapter emits session-head context rather than a produced-commit claim; the
parser is intentionally bounded to the observed rollout envelope; missing or
relocated repository context may remain unknown; and incomplete evidence lowers
coverage rather than supporting a causal claim. No blocking documentation or
operational audit finding remains.

## Git handoff

At audit start the local branch was ahead of
`origin/feat/conservative-correlation` by 24 commits at `6ecbf33`. The
documentation commit leaves the remote branch unchanged and the local branch
one commit further ahead. Push and coordinator-owned final verification were
intentionally not performed, as requested. The requested history, feature-diff
stat, and status summaries were inspected locally before handoff.

### Requested Git summaries

The following exact summaries were captured after the initial local Task 8
commit and before the final same-message report amend:

`git log --oneline --decorate -n 15`

```text
713d428 (HEAD -> feat/conservative-correlation) docs: record integrated correlation behavior
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
3f8e8e4 fix: address conservative correlation review findings
```

`git diff --stat main...HEAD`

```text
33 files changed, 8273 insertions(+), 56 deletions(-)
```

The complete command output listed the Task 8 report, architecture, governing
spec/plan, prior task reports, correlation implementation, and test files; no
unrelated production files were present.

`git status --short`

```text
(empty)
```

The remote-tracking ref remained `origin/feat/conservative-correlation` at
`004fb49`; the local branch was `[ahead 25]`. The amend changes the local
commit hash but does not change this remote state or introduce a push.
