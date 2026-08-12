# Symbol-Aware Provenance Queries Design

**Status:** approved by the milestone brief
**Date:** 2026-08-11
**Branch:** `feat/symbol-aware-provenance`

## Goal

Add file-scoped exact symbol queries:

```text
whyline --symbol parseToken src/parser.ts
whyline --details --symbol Parser.parseToken src/parser.ts
```

The symbol layer resolves current-worktree syntax into one declaration-covering
line span and then delegates to the existing range provenance engine. It is
navigation context only: it does not add a provenance domain or infer
historical identity, rename continuity, semantic identity, or symbol origin.

## Scope and safety invariants

The parser supports TypeScript-family `.ts`, `.mts`, `.cts`, `.d.ts`, `.tsx`
and JavaScript-family `.js`, `.mjs`, `.cjs`, `.jsx` files with ASCII
case-insensitive extension matching. Vue, Svelte, MDX, Flow syntax,
extensionless files, embedded-language formats, other languages, and
repository-wide lookup remain unsupported. Paths retain their actual
canonical repository spelling and remain argv-safe for whitespace, Unicode,
colons, and dash-leading names.

TypeScript 5.9.x remains locked and moves to runtime dependencies. The
compiler is dynamically imported only on symbol queries. Resolution uses
public compiler APIs, one in-memory current file, explicit ScriptKind,
`noLib`, `noResolve`, no tsconfig discovery, no imports/dependencies, no type
checking, and only syntactic diagnostics. Any syntactic diagnostic anywhere in
the current file rejects resolution with exit 2 and a bounded first-location
message. Parser load/initialization failures remain operational exit 3.

The resolver consumes the exact bytes used later by provenance analysis. Path
canonicalization, containment and symlink checks, UTF-8/binary validation,
target status, and the immutable source snapshot happen once. The decoded text
and snapshot flow to both the parser and `ResolvedRangeCodeLocation`; ordinary
range resolution is not allowed to reread a symbol target before analysis.
Final HEAD, branch, file snapshot, and status verification remains in the
shared range core, so mutation still returns exit 3.

## Query model and selector semantics

The CLI parser returns a discriminated query model with `location` and
`symbol` variants. Existing line/range forms remain unchanged. Symbol syntax
requires `--symbol <selector> <file>`, optionally preceded by `--details`.
Missing/extra/repeated/misplaced flags and malformed selectors are usage/input
errors (exit 2). Selector validation only rejects empty selectors, leading or
trailing dots, and empty components. It deliberately allows Unicode and other
legitimate identifier text; parser-produced candidate names are authoritative.
Matching is exact string equality against `candidate.name` for unqualified
selectors and `candidate.qualifiedName` for qualified selectors. There is no
fuzzy, case-insensitive, suffix, proximity, or best-candidate matching.

## Syntax resolver

The internal candidate model records the language, dialect, parser name and
version, public kind, simple name, qualified name, and inclusive start/end
lines. Supported public kinds are `function`, `method`, `constructor`,
`class`, `interface`, `type`, and `enum`. A single identifier-bound `const`
whose direct initializer is an arrow or function expression is public kind
`function`; its Whyline name is the binding, never an internal function
expression name.

The collector walks the current file AST and supports named declarations,
decorators/modifiers, nested queryable declarations, class methods and
constructors, and named default declarations. Unsupported forms remain
absent: anonymous defaults, `let`/`var` function values, multi-declarators,
destructuring, object-literal methods, accessors, fields, private/computed or
literal method names, interface members/call signatures, enum members, class
expressions, namespaces/modules, imports/exports as standalone symbols,
non-function variables, properties, and labels.

Qualification is the dot-joined chain of enclosing queryable named
declarations. A class participates in method qualification; nested functions
inherit the enclosing named chain. `getStart(sourceFile, false)` and
`node.end` are the only declaration boundaries. The resulting inclusive lines
are calculated from `lineOf(start) + 1` through `lineOf(end - 1) + 1`, with
defensive handling for empty/invalid ends. This produces the smallest
declaration-covering line span:

```text
exact current-worktree AST declaration
        ↓
minimal inclusive covering line span
        ↓
existing line-granular range provenance
```

Leading trivia/JSDoc and trailing comments on separate lines outside the AST
declaration are excluded. Decorators, modifiers, signatures, bodies, closing
braces, semicolons, and physically interior comments are included naturally by
the AST range. Trivia or unrelated syntax sharing the first or last resolved
line is included because the existing provenance unit is a complete line; the
result is not a character-exclusive provenance range.

Overload families are grouped syntactically only. A contiguous sibling run
groups when declaration kind/name/container/staticness match, every preceding
declaration lacks a body, and at most the final declaration has a body. An
ambient all-signature run may group. Bodies before later declarations,
unrelated siblings, changed staticness, incompatible forms, and changed
containers prevent grouping; those candidates remain separate and can be
ambiguous.

Exact matches must be unique. Ambiguous candidates are sorted by start line,
end line, public kind, and qualified name, render at most 12 candidates, and
report the exact omitted count. The user is directed to use a qualified name
or an explicitly displayed range; no discriminator is invented for duplicate
qualified names or unavoidable declaration merging. Resolved ranges over 200
inclusive lines fail before blame, commit inspection, ancestry, or Codex work.

## Shared range core and rendering

The existing range wrapper becomes a thin explicit-range parser/resolver
adapter around:

```text
analyzeResolvedRange(repository, resolvedLocation, options)
```

That core owns baseline range blame, grouping, commit inspection, exact
ancestry, Codex preparation/projection, the 24 committed-group bound, report
assembly, final stability verification, privacy, and all existing evidence
semantics. A symbol coordinator discovers the repository, resolves one source
snapshot, resolves the selector, checks the 200-line limit, constructs the
same-snapshot declaration-covering line span, and invokes the core exactly
once. A successful symbol report is evidence-equivalent to querying the same
explicit line range over the same source state.

Range summary/details sections are reused through a narrow header/context
seam. Symbol summary output begins with the repository path and qualified name,
kind, and lines. Details adds bounded current-worktree resolver metadata:
language, dialect, parser/version, selector, qualified name, resolved range,
declaration-covering line span boundary, and the limitations that provenance
is line-granular and no historical symbol identity is inferred. No AST dump,
source excerpt, compiler diagnostic body, historical identity, rename, or
symbol-origin wording is rendered.

## Error mapping and testing

Exit 2 covers unsupported extension, malformed selector, not found,
ambiguity, syntax diagnostics, and over-limit ranges. Exit 3 covers parser
dependency/runtime failures, ordinary repository/file failures, and source or
repository mutation. Dirty tracked and untracked supported files resolve from
current contents and retain the range engine’s existing uncommitted/no-Codex
semantics.

Focused TDD tests cover CLI parsing, one-read snapshot retention, all supported
dialects, syntax isolation, declarations/boundaries, Unicode names, nested
qualification, overload grouping, unsupported forms, deterministic ambiguity,
12-candidate omission, early 200-line rejection, range-core delegation,
rendering privacy, mutation stability, and one disposable real-Git CLI
acceptance fixture with committed movement, an uncommitted edit, ambiguity,
and an over-limit symbol.

## Explicit non-goals

No repository-wide search, Tree-sitter, LSP, IDE integration, historical
symbol tracking, rename/call/reference/type/import/export analysis,
transformed or semantic ancestry, JSON schema, parser plugin system,
persistent cache/index, network service, new agent adapter, or provenance
domain is introduced.
