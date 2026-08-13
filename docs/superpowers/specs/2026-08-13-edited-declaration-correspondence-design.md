# Explain Edited Declarations Design

**Status:** approved by the milestone brief
**Date:** 2026-08-13
**Branch:** `feat/edited-declaration-correspondence`

## Goal

Add one conservative, one-hop ancestry relationship for materially edited
TypeScript-family declarations:

```text
verified direct-parent declaration correspondence
```

The relationship says that a queried line belongs to a child declaration at
textual commit `T`, that the selected direct parent `P` contains exactly one
declaration with the same frozen syntactic key, that the actual `P -> T`
edit hunk connects the declaration regions, and that the pair contains one
uniquely aligned strong exact preserved anchor. It is positive deterministic
evidence, but it is strictly weaker than exact line ancestry.

It does not prove that the queried line existed in `P`, semantic equivalence,
historical symbol identity, origin, authorship, intent, move versus copy, or
any relationship across more than `P -> T`.

## Frozen result ordering and coverage

The ancestry hierarchy remains:

```text
exact > transformed / direct-parent-declaration > uncertain / none / unavailable
```

`GitAncestryResult` gains a distinct transformed variant with relationship
`direct-parent-declaration`. It retains bounded evidence for `T`, `P`,
child and parent paths, child and parent declaration spans, frozen key, selected
parent evidence, hunk connectivity, preserved-anchor counts, and explicit
limitations. It never stores historical source excerpts, AST nodes, raw diff
payloads, confidence scores, or a semantic identity.

The range model gains a distinct `transformed` segment status and the same
bounded evidence. Coverage is line-specific. Exact lines are written first;
transformed analysis is attempted only for queried lines that remain
non-exact. A positive pair proof never promotes all lines in a declaration,
textual group, range, or symbol. Uncommitted lines remain `not-run`.

## Reusable declaration index

`src/symbol/declaration-index.ts` becomes the one syntax contract for current
and historical TypeScript-family parsing. It accepts only a provided
repository path and in-memory UTF-8 text. It uses the existing public
TypeScript compiler API, explicit script kind, syntax diagnostics only, no
type checking, no imports, no tsconfig discovery, no filesystem traversal,
no parser state persistence, and no regex fallback.

The index returns bounded supported declaration facts, not AST nodes. A fact
contains its innermost declaration-covering line span, source offsets for
internal exact text slicing, kind, exact qualified name, declaration form,
method staticness, and the grouped-overload identity needed by the existing
resolver. Supported extensions, Unicode names, qualification, overload
grouping, ambiguity, syntax diagnostics, unsupported forms, and the existing
200-line current-symbol limit remain unchanged.

Historical parsing uses the blob text itself. A syntax diagnostic or invalid
historical material is never recovered or treated as authoritative; it
produces a conservative non-positive/unavailable result.

## Pure correspondence proof

`src/ancestry/declaration-correspondence-proof.ts` is a side-effect-free
function. It receives complete child/parent text and line arrays, declaration
facts, queried child line, parsed hunk facts, and an exact-ancestry-eligibility
flag. It does not invoke Git, read files, inspect repository state, use time,
or call Codex.

The proof performs these checks in order:

1. reject if exact ancestry already succeeded;
2. select exactly one innermost supported child declaration covering the
   queried line;
3. select exactly one parent declaration whose key exactly matches kind,
   qualified name, declaration form, and method staticness;
4. require the queried line to be an added new-side line in a qualifying hunk
   that overlaps the child declaration and either overlaps the parent
   declaration on the old side or is an insertion at a line inside the parent
   declaration under the frozen insertion rule;
5. reject byte-identical declaration texts;
6. search exact line pairs for one uniquely aligned contiguous preserved
   anchor with at least two unique distinctive lines, at least 40
   alphanumeric characters, and at most 32 matched lines;
7. return transformed evidence only if all material is complete.

The insertion point is the hunk `oldStart` value, with a zero start treated as
the file-start position; it qualifies only when it falls within the inclusive
parent declaration span. Anchor alignment is identified by maximal contiguous
exact diagonal runs. Multiple distinct runs satisfying the strength floor are
ambiguous, never selected by score or position. A declaration pair may spend
at most 40,000 exact line-pair checks; crossing that bound is
`unavailable / work-bound`. Child or parent declarations over 200 lines,
incomplete/truncated material, and parser failures are also unavailable or
conservative non-positive rather than transformed.

## Git evidence and path mapping

`src/git/trace-declaration-correspondence.ts` receives existing committed
attribution and the already-selected parent. It uses argv-only, read-only Git
calls to resolve `T:path` and `P:path`, applies the 2 MiB limit before
parsing, rejects binary/NUL and invalid UTF-8 blobs, parses both blobs through
the declaration index, and passes existing parsed `P -> T` hunks into the
pure proof.

Path mapping is limited to the same path or one directly observed connected
Git rename in the actual transition. A connected rename is an existing
changed-path fact whose old path is the parent path and new path is the child
path. No parent-tree search, basename matching, filesystem search, parser
search, or similarity-based discovery is added. Copy and move intent remain
unclaimed.

Parent selection is never recomputed. Root commits do not attempt
correspondence; ambiguous merges have no positive result; shallow or missing
objects fail conservatively. The one-hop transition is never recursively
walked.

## Work bounds and caching

The existing first-24-committed-textual-group deep-analysis bound remains
unchanged; later groups are `unavailable / work-bound`, never `none`.

An invocation-local correspondence cache tracks declaration-pair attempt
identity by textual commit, selected parent, child path, parent path, and
declaration key/span where needed. It permits at most 12 unique attempts in
source order. A candidate requiring attempt 13 is `unavailable / work-bound`
even if it might otherwise have proved positive. Repeated lines using the same
pair reuse the completed proof and do not spend another attempt. Range exact
coverage is populated first and cannot be weakened by cache or transformed
work-bound outcomes.

## Integration and rendering

Single-line tracing keeps the existing exact ancestry implementation and
result semantics intact, then invokes correspondence only for still-non-exact
eligible committed lines. Range tracing keeps existing movement/exact proof
and partitions exact coverage first, then overlays transformed coverage for
qualifying queried lines. Codex preparation, candidate thresholds, session
head semantics, privacy, material coverage, and all Codex statuses are
untouched.

The ancestry heading is `Git ancestry` for both exact and transformed output.
Exact output remains clearly exact. Transformed output uses language such as
`verified direct-parent declaration correspondence`, identifies the parent
declaration and hunk/anchor evidence, and explicitly states that the queried
line is not an exact ancestor match. It never says same symbol, historical
symbol, origin, semantic equivalence, authorship, move, or copy. Details show
bounded IDs, paths, spans, key fields, parent-selection evidence, hunk
relationship, and anchor counts only; no historical source or AST is printed.

## Testing and acceptance

TDD coverage is added at the pure proof, declaration index, Git tracer, range
coverage, single-line coordinator, renderer, and compiled CLI acceptance
boundaries. Tests cover positive and every frozen negative/limited condition,
exact precedence, unique parent/path mapping, connected rename, root/merge/
shallow/binary/invalid UTF-8 failures, all work bounds, cache identity,
mixed exact/transformed/uncertain/dirty ranges, current and historical
TypeScript-family parsing, and Codex independence.

The compiled acceptance fixture contains one symbol/range with an exact moved
block, a qualifying edited line, an insufficient-anchor edited line, an
uncommitted line, and empty Codex history. The final normal verification is
exactly:

```text
npm run check
git diff --check
```

No network, checkout, mutation, push, PR, or merge is part of this feature.
