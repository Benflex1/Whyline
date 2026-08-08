# Task 7 implementation and self-review report

## Scope delivered

Added only the synthetic end-to-end test file:

- `test/correlation-e2e.test.ts`

No redacted fixture file, existing helper, or production file was modified.
The tests create temporary Git repositories and use an injected synthetic
`AgentHistorySource`; every Codex-home path is fixture-owned and no real
`~/.codex` is read.

## Coverage delivered

The new suite covers:

- structured update matching, unrelated evidence, two matching candidates,
  plausible-only evidence with fixed possible/insufficient wording, empty and
  unavailable history, and the uncommitted zero-discovery early return;
- stale session-head context with equivalent current patch content and
  privacy-sensitive source paths, URLs, command markers, and absolute paths
  absent from terminal output and normalized correlation;
- 40 discovered refs with all summaries read, 32-or-fewer full extractions,
  material candidate-cap coverage, and no uniqueness claim under incomplete
  coverage;
- current, linked, and deleted linked worktree contexts plus a known unrelated
  repository excluded before extraction;
- operation-aware update/add/delete patch matching and earlier/later competing
  patch chronology;
- benign unknown records, material partial/corrupt/changed-during-read/
  compaction coverage, and truncated Git hunks without invented divergence;
- an argv-recording Git wrapper proving the analysis performs no remote Git
  operation. The synthetic source has no transcript execution path and rejects
  legacy discovery use.

## TDD and verification

The new test file was added before behavioral verification. The first build
stopped on an exact-optional-property fixture typing error; after correcting
the fixture, the focused run exposed one privacy assertion caused by deriving
the safe session ID from a sensitive filename. That fixture was corrected and
the focused suite passed.

Fresh verification:

```text
npm run build && node --test dist/test/correlation-e2e.test.js
12 passed, 0 failed

npm run check
110 passed, 0 failed; typecheck passed

git diff --check
clean
```

## Self-review

One self-review checked the Task 7 bullet list, changed-file scope, temporary
home/repository cleanup, bounded extraction counters, fixed IDs/timestamps,
renderer privacy, and remote/transcript execution boundaries. No Task 8 work
was started.

## Correction round

Addressed the four review gaps in `test/correlation-e2e.test.ts` only:

- ambiguity now requires exactly two alternatives, both `strong`, each with a
  direct `structured-patch-overlap` signal;
- the 40-ref cap source records and asserts unique summary/extraction ref paths
  and session IDs, explicitly identifies the eight omitted refs, and verifies
  the retained observed candidate is strong while material `candidate-cap`
  coverage keeps the result at `none`;
- every E2E analysis now uses a failing strict Git runner with an exact local
  read-only argv/config/input allowlist. Unknown, remote, transport, and
  mutating commands fail before delegation;
- the missing-history fake asserts the exact supplied missing `historyRoot` and
  continues to verify successful Git provenance with unavailable Codex status.

Correction-round verification:

```text
npm run build && node --test dist/test/correlation-e2e.test.js
12 passed, 0 failed

npm run check
110 passed, 0 failed; typecheck passed
```

No production changes or Task 8 work were made.
