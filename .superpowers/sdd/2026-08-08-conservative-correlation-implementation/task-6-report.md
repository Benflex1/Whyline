# Task 6 implementation report

## Scope delivered

Implemented the combined bounded terminal report on `feat/conservative-correlation`:

- Added `src/cli/render-correlation.ts`, consuming only normalized `CorrelationResult`.
- Added `test/correlation-render.test.ts` with exact matched, ambiguous, possible-only, none, and unavailable cases.
- Updated `src/cli/render-text.ts` to append Codex evidence only for committed reports that contain a correlation result.

## Renderer behavior

- Uses fixed presentation maps for every closed signal, contradiction, limitation,
  correlation status, and coverage status kind.
- Never renders scores, probabilities, evidence IDs, prompts, reasoning, commands,
  output, patch source, URLs, source paths, absolute working directories, or
  filename-derived identity.
- Renders `Likely related Codex session` only for a selected match.
- Renders `Possible related session` only for one plausible or retained strong
  alternative when no final selection is justified.
- Ambiguous results explicitly select no session.
- Candidate IDs start with a bounded prefix and extend until all displayed IDs are
  distinct, using the full normalized ID when required.
- Existing Git-only output remains unchanged for uncommitted and untracked reports.

## TDD and verification

The renderer test was written before its production module. The required red run
failed at TypeScript compilation with the expected missing-module error for
`src/cli/render-correlation.ts`. After implementation:

```text
npm run build && node --test dist/test/correlation-render.test.js
5 passed, 0 failed

npm run check
typecheck passed
95 passed, 0 failed

git diff --check
passed
```

The self-review checked the requested file scope, exhaustive fixed-kind maps,
collision-safe displayed IDs, committed-only attachment, and a source-level
privacy scan. Tasks 7 and 8 were not started.

## Correction round

Addressed the five Task 6 review findings without changing the renderer boundary
or committed-only integration:

- Selected and possible candidates now use the same collision-aware allocator.
  Session IDs are injectively encoded for safe terminal display, capped at 80
  characters, and extended with a session-ID-derived SHA-256 suffix when needed.
  Exact duplicate session identities are displayed once.
- `Likely related Codex session` requires both `status: "matched"` and
  `selected.band: "strong"`. A plausible selected candidate falls back to the
  possible wording instead of claiming a match.
- Possible output always includes the fixed sentence `Evidence is insufficient
  to claim a match.`
- Added regressions for long selected/possible IDs, post-encoding collisions,
  invalid matched/plausible selection, and insufficiency wording. Existing
  status and committed-only tests remain covered.

Correction-round verification:

```text
npm run build && node --test dist/test/correlation-render.test.js
8 passed, 0 failed

npm run check
typecheck passed
98 passed, 0 failed

git diff --check
passed
```

The correction remains Task 6 only. Tasks 7 and 8 were not started.
