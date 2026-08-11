# Symbol-Aware Provenance Queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact file-scoped TypeScript/JavaScript symbol queries that resolve one current-worktree declaration range and reuse Whyline’s existing range provenance evidence unchanged.

**Architecture:** Introduce a discriminated CLI query model and a single-read current-source snapshot seam. A lazy TypeScript 5.9 syntax-only resolver collects supported declarations, applies exact Unicode-safe selector matching, syntactic overload grouping, and deterministic ambiguity handling, then constructs a `ResolvedRangeCodeLocation` from the same snapshot. Refactor range provenance into an exported `analyzeResolvedRange` core; symbol orchestration and symbol renderers wrap that core without adding a provenance domain.

**Tech Stack:** TypeScript 5.9.3 runtime dependency, Node.js 24, ESM, built-in `node:test`, existing GitRunner/GitProcess, existing range provenance/ancestry/Codex modules, argv-only local read-only Git.

## Global Constraints

- Support exactly `.ts`, `.mts`, `.cts`, `.d.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, and `.jsx`, with ASCII case-insensitive extension matching; preserve the actual canonical path.
- Use only the public TypeScript 5.9 compiler API; load it lazily only for symbol queries.
- Parse one current-worktree source file in memory with explicit ScriptKind, `noLib`, `noResolve`, no tsconfig discovery, no import resolution, and no type checking.
- Any syntactic diagnostic anywhere in the current file is exit 2 with one bounded first-location message; parser load or runtime failure is exit 3.
- Selector validation rejects only empty selectors, leading/trailing dots, and empty components; Unicode selector components remain valid and matching is exact parser-produced name equality.
- Public symbol kinds are function, method, constructor, class, interface, type, and enum; unsupported declarations remain absent.
- Use `node.getStart(sourceFile, false)` and `node.end`, convert to one-based inclusive lines, and retain AST boundaries without manual trivia expansion.
- Group overloads only by the frozen contiguous syntax-only rules; never use a type checker, symbol identity, signatures, or semantic resolution.
- A resolved symbol range over 200 inclusive lines fails before blame, commit inspection, ancestry, or Codex analysis; reuse `MAX_RANGE_LINES`.
- The parser and range engine consume one authoritative current-file snapshot; final existing HEAD/branch/file/status stability verification remains in the shared core.
- Explicit line/range output and Git, ancestry, Codex, privacy, offline, read-only, and 24-group work-bound semantics remain unchanged.
- Never add repository-wide lookup, fuzzy search, suffix matching, historical symbol identity, rename tracking, call/reference/type/import/export analysis, JSON, caches, LSP, Tree-sitter, or new adapters.

---

### Task 1: CLI query model and current-source snapshot seam

**Files:**
- Modify: `src/cli/parse-arguments.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/location/resolve-location.ts`
- Modify: `src/provenance/model.ts`
- Test: `test/cli.test.ts`
- Test: `test/location-range.test.ts`

**Interfaces:**
- Replace the CLI’s location-only value with `CliQuery = { kind: "location"; location: string } | { kind: "symbol"; selector: string; file: string }`, while retaining `details`.
- Add an internal current-source result containing canonical path, repository path, bytes/text, split lines, `FileSnapshot`, target status, and dirty flag. `resolveCurrentSource(file, context, runner, currentDirectory)` performs canonicalization, one `stat`/read/decode, and one target-status lookup.
- Add `resolvedRangeLocationFromSource(parsed, source)` to construct `ResolvedRangeCodeLocation` without reading the file again. Keep `resolveRangeLocation` as the explicit-query adapter that calls the seam once.
- Keep `currentLocationSnapshot` as the final verification reread; it is not used between symbol parsing and provenance resolution.

- [ ] **Step 1: Write failing CLI tests** for the location discriminant, `--symbol selector file`, `--details --symbol selector file`, missing selector/file, extra positional arguments, misplaced/repeated flags, Unicode selectors, empty/leading/trailing/double-dot selectors, and single/double-dash-leading files.
- [ ] **Step 2: Run the CLI tests red** with `npm run build && node --test dist/test/cli.test.js`; confirm the new assertions fail because the current parser only accepts one location string.
- [ ] **Step 3: Implement exact positional flag parsing**. Accept only `[file:line|range]`, `[--details, file:line|range]`, `[--symbol, selector, file]`, and `[--details, --symbol, selector, file]`. Treat the final symbol file argument as opaque, including spaces, Unicode, colons, and leading dashes; reject repeated/misplaced flags and structurally malformed selectors with exit 2.
- [ ] **Step 4: Write a failing resolver seam test** that counts filesystem reads for a supported UTF-8 file with Unicode content and a path containing spaces/colons, and asserts the same decoded text/snapshot feeds range construction.
- [ ] **Step 5: Implement `resolveCurrentSource`** by extracting only the existing canonical-path, symlink repository guard, `readSnapshot`, UTF-8 decoder, line splitting, bounded line content/digest, and `readTargetStatus` logic. Retain containment, symlink, binary, and status behavior exactly.
- [ ] **Step 6: Route `resolveRangeLocation` through the source seam**, and update `main.ts` to dispatch location queries exactly as before while leaving symbol dispatch to the later coordinator. Run `npm run build && node --test dist/test/cli.test.js dist/test/location-range.test.js`.
- [ ] **Step 7: Commit** `git add src/cli src/location/resolve-location.ts src/provenance/model.ts test/cli.test.ts test/location-range.test.ts && git commit -m "feat: add symbol query model and source snapshot seam"`.

### Task 2: Lazy TypeScript-family parser and public symbol model

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/symbol/model.ts`
- Create: `src/symbol/typescript-resolver.ts`
- Test: `test/symbol-resolver.test.ts`

**Interfaces:**
- `SymbolResolution` contains `language`, `dialect`, `parser`, `parserVersion`, public `kind`, `name`, `qualifiedName`, `startLine`, `endLine`, and `boundary`.
- `SourceSymbolResolution` accepts a validated selector and current-source snapshot, returning one resolution or throwing `InvalidInputError`/`OperationalError`.
- `resolveTypeScriptSymbol(selector, source): Promise<SymbolResolution>` dynamically imports TypeScript only inside the function and never reads the file system.
- `supportedDialectForPath(repositoryPath)` returns the TypeScript/JavaScript language and `ts | tsx | js | jsx` dialect or throws exit 2 for unsupported extensions.

- [ ] **Step 1: Move TypeScript’s unchanged `^5.9.2` entry** from `devDependencies` to `dependencies`, run `npm install`, and assert `npm ls typescript --depth=0` reports 5.9.3 without an upgrade.
- [ ] **Step 2: Write failing resolver tests** for all nine extension forms, case-insensitive suffixes, unsupported Vue/Svelte/MDX/extensionless files, parser metadata, no-tsconfig/no-import behavior, and malformed syntax rejection with one first line/column and no diagnostic body/source excerpt.
- [ ] **Step 3: Run resolver tests red** with `npm run build && node --test dist/test/symbol-resolver.test.js`; confirm the new module is absent.
- [ ] **Step 4: Implement extension mapping and lazy import** using `import("typescript")` behind an invocation-local promise. Map `.ts/.mts/.cts/.d.ts` to `ScriptKind.TS`, `.tsx` to TSX, `.js/.mjs/.cjs` to JS, and `.jsx` to JSX; use parser version `ts.version`.
- [ ] **Step 5: Implement the in-memory compiler host** with one root source file, `noLib: true`, `noResolve: true`, `allowJs: true`, explicit JSX setting, no config parsing, `fileExists/readFile/getSourceFile` limited to the root, and `resolveModuleNames` returning no modules. Create a `Program`, request only `getSyntacticDiagnostics(sourceFile)`, sort by position, and convert the first useful location to a bounded `InvalidInputError`.
- [ ] **Step 6: Add runtime failure boundaries** so module-load, program-construction, or parser runtime errors become `OperationalError` and are not reported as not-found symbols. Run the focused resolver suite green.
- [ ] **Step 7: Commit** `git add package.json package-lock.json src/symbol/model.ts src/symbol/typescript-resolver.ts test/symbol-resolver.test.ts && git commit -m "feat: add lazy TypeScript symbol parser"`.

### Task 3: Declaration collection, ranges, qualification, overloads, and ambiguity

**Files:**
- Modify: `src/symbol/typescript-resolver.ts`
- Modify: `src/symbol/model.ts`
- Create: `test/symbol-declarations.test.ts`
- Create: `test/symbol-ambiguity.test.ts`

**Interfaces:**
- Internal candidates carry the AST node, public kind/name/qualified name, parent container identity, declaration form, static/instance status, body presence, and source order; only final `SymbolResolution` leaves the module.
- `collectQueryableCandidates(sourceFile, ts)` returns deterministic resolved candidates after overload grouping; it never invokes a type checker.
- `selectSymbol(candidates, selector, path)` performs exact simple-vs-qualified matching, throws bounded ambiguity/not-found errors, and reports up to 12 sorted candidates with exact omitted count.

- [ ] **Step 1: Write failing declaration tests** for named functions, named default functions, classes, named default classes, decorated declarations, methods, constructors, interfaces, type aliases, enums, direct const arrows/function expressions, modifiers, generics, multiline signatures, nested functions/methods, CRLF/BOM/missing-final-newline, Unicode identifiers, and comment/trivia boundaries.
- [ ] **Step 2: Assert exact boundaries**: JSDoc/leading trivia excluded, decorators/modifiers included, closing braces/terminating semicolons included, comments inside nodes naturally retained, and trailing comments after `node.end` excluded. Use `node.getStart(sourceFile, false)` and `node.end` with inclusive `end - 1` line conversion.
- [ ] **Step 3: Write failing unsupported-form tests** for anonymous defaults, let/var function values, multi-declarators, destructuring, object methods, getters/setters, fields, private/computed/string/numeric methods, interface members/call signatures, enum members, class expressions, namespaces, imports/exports as symbols, non-function variables, properties, and labels.
- [ ] **Step 4: Implement the AST visitor** using public `ts.is*` guards. Add candidates for named function/class/interface/type/enum declarations, identifier-named ordinary methods and constructors, and one-declarator const variables whose initializer is an arrow/function expression. Treat the const binding as the name and do not emit an internal function-expression name.
- [ ] **Step 5: Implement qualification** as the dot-joined chain of enclosing queryable named declarations. Include classes and methods in the chain; allow nested named functions to produce forms such as `outer.inner` and `Parser.parseToken.decode`.
- [ ] **Step 6: Implement syntactic overload grouping** over direct sibling runs. Require same kind/name/container/staticness, no body before the final member, at most one final body, and ambient/declaration context for all-signature runs. Stop on unrelated siblings, body-before-later declarations, incompatible declaration form, changed container, or staticness mismatch. Use first start through final end for grouped range.
- [ ] **Step 7: Implement exact selection and deterministic ambiguity**. Unqualified selectors compare `candidate.name`; qualified selectors compare `candidate.qualifiedName`. Sort matches by start line, end line, kind, qualified name; render no more than 12 and state the exact omitted count plus explicit-range guidance. Never score or choose automatically.
- [ ] **Step 8: Add the shared `MAX_RANGE_LINES` check** after selection and before any provenance call. Report selector, span, and the 200-line limit with exit 2. Run all symbol declaration/ambiguity tests.
- [ ] **Step 9: Commit** `git add src/symbol test/symbol-declarations.test.ts test/symbol-ambiguity.test.ts && git commit -m "feat: resolve exact declarations and overloads"`.

### Task 4: Extract the authoritative resolved-range provenance core

**Files:**
- Modify: `src/provenance/explain-range.ts`
- Modify: `src/provenance/range-model.ts` only if report metadata needs a narrow type seam
- Test: `test/range-provenance-flow.test.ts`
- Test: `test/range-acceptance.test.ts`

**Interfaces:**
- Export `analyzeResolvedRange(repository: RepositoryContext, location: ResolvedRangeCodeLocation, options: AnalyzeRangeOptions): Promise<WhylineRangeReport>` containing everything currently after explicit range resolution.
- Keep `analyzeRange(input, options)` as parse/discover/resolve wrapper that calls `analyzeResolvedRange` once.
- Preserve `RangeAnalysisHooks`, exact report types, 24-group constant, Codex preparation/projection, ancestry, privacy, and final stability verification.

- [ ] **Step 1: Add a failing equivalence test** with a temporary Git repository and a resolved location object asserting explicit range analysis and direct `analyzeResolvedRange` produce equal range evidence for the same snapshot/options.
- [ ] **Step 2: Run the focused range suite red** with `npm run build && node --test dist/test/range-provenance-flow.test.js`; verify the exported seam does not exist.
- [ ] **Step 3: Move the existing range body** after `resolveRangeLocation` into `analyzeResolvedRange` without changing facts, grouping, inspection, ancestry, Codex, 24-group, report, hook, or final verification code. Make the explicit wrapper call it.
- [ ] **Step 4: Add an invocation-local instrumentation assertion** that the core is called once for a symbol-derived request and that a 201-line rejection performs no baseline blame, commit inspection, ancestry, or Codex discovery.
- [ ] **Step 5: Run the full existing range suite** with `npm run build && node --test dist/test/range-*.test.js dist/test/location-range.test.js`; fix only concrete regressions and commit `git add src/provenance/explain-range.ts test/range-provenance-flow.test.ts test/range-acceptance.test.ts && git commit -m "refactor: extract resolved range provenance core"`.

### Task 5: Symbol orchestration and symbol report rendering

**Files:**
- Create: `src/provenance/explain-symbol.ts`
- Create: `src/cli/render-symbol-summary.ts`
- Create: `src/cli/render-symbol-details.ts`
- Modify: `src/cli/main.ts`
- Test: `test/symbol-provenance.test.ts`
- Test: `test/symbol-render.test.ts`

**Interfaces:**
- `WhylineSymbolReport` contains `symbol: SymbolResolution` and `range: WhylineRangeReport`; the range report remains the sole evidence domain.
- `analyzeSymbol(selector, file, options): Promise<WhylineSymbolReport>` discovers the repository, resolves one current source, selects/checks one symbol, constructs a range location from that source, and calls `analyzeResolvedRange` exactly once.
- `renderSymbolSummary(report)` and `renderSymbolDetails(report)` render symbol headers/metadata and reuse the existing range summary/details sections through a narrow custom-header helper; normal range output remains byte-for-byte behaviorally unchanged.

- [ ] **Step 1: Write failing orchestration tests** for committed, mixed committed/uncommitted, untracked, Unicode path, symbol-derived vs explicit-range evidence, no Codex for uncommitted groups, exact ancestry unchanged, and final source mutation returning exit 3.
- [ ] **Step 2: Implement `analyzeSymbol`** with `resolveCurrentSource`, lazy syntax resolution, ambiguity/not-found/error mapping, 200-line early rejection, `ResolvedRangeCodeLocation` construction from the same decoded text/snapshot, and one `analyzeResolvedRange` call.
- [ ] **Step 3: Add failing renderer tests** for the concise header (`path — qualifiedName`, kind/lines), details resolver metadata (language, dialect, TypeScript 5.9.3, selector, qualified name, range, complete declaration boundary, no historical identity), ambiguity/syntax/over-limit error sanitization, Unicode names/paths, and no AST/source/compiler diagnostic leakage.
- [ ] **Step 4: Factor range renderer sections** into internal functions accepting a first-header/context prefix. Keep the normal `renderRangeSummary` and `renderRangeDetails` output unchanged; symbol renderers add only the symbol header and bounded resolution section before the existing sections.
- [ ] **Step 5: Dispatch CLI symbol queries** in `main.ts` to `analyzeSymbol` and the symbol renderers; leave location query dispatch unchanged. Run `npm run build && node --test dist/test/symbol-provenance.test.js dist/test/symbol-render.test.js dist/test/cli.test.js`.
- [ ] **Step 6: Commit** `git add src/provenance/explain-symbol.ts src/cli/main.ts src/cli/render-symbol-summary.ts src/cli/render-symbol-details.ts test/symbol-provenance.test.ts test/symbol-render.test.ts && git commit -m "feat: analyze and render symbol provenance"`.

### Task 6: Disposable real-CLI symbol acceptance and documentation

**Files:**
- Create or modify: `test/symbol-acceptance.test.ts`
- Modify: `docs/whyline-v0-architecture.md`

**Interfaces:**
- The acceptance fixture invokes the compiled CLI in a disposable real Git repository and does not use network, persistent caches, or ambient Codex data.

- [ ] **Step 1: Write the failing acceptance fixture** with a supported TS/TSX file whose decorated overloaded method has at least two textual commits inside its range, an exact moved block, an uncommitted edit, an unrelated duplicate simple method name, and a filename containing spaces/colon/Unicode/leading dash.
- [ ] **Step 2: Run the compiled acceptance test red** with `npm run build && node --test dist/test/symbol-acceptance.test.js` before the implementation is wired into the CLI.
- [ ] **Step 3: Implement the fixture assertions** for concise `--symbol`, `--details --symbol`, ambiguity, and >200-line rejection. Assert resolved header/metadata, mixed textual groups, partial exact ancestry, dirty not-run ancestry/Codex, no symbol-origin/historical-identity wording, candidate capping, and exit codes 0/2.
- [ ] **Step 4: Update architecture documentation** with supported extensions/dialects, query forms, current-worktree syntax limitation, same-snapshot seam, supported declarations, overload/ambiguity rules, range delegation, and unchanged provenance domains/non-goals.
- [ ] **Step 5: Run focused compiled acceptance** once after the fixture is green and commit `git add test/symbol-acceptance.test.ts docs/whyline-v0-architecture.md && git commit -m "test: add symbol CLI acceptance"`.

### Task 7: Single bounded final verification and diff inspection

- [ ] **Step 1: Run exactly one normal final pass**: `npm run check`, then `git diff --check`. If `npm run check` already executes the compiled symbol acceptance test, do not run that acceptance test again; otherwise run it once as `node --test dist/test/symbol-acceptance.test.js`.
- [ ] **Step 2: Inspect only the required final surfaces**: `git diff --stat`, `git status --short`, dependency/runtime scope, extension/language scope, Unicode selector validation, AST boundaries, overload grouping, deterministic ambiguity, syntax rejection, 200-line early failure, same-snapshot data flow, `analyzeResolvedRange` delegation, unchanged Git/ancestry/Codex/privacy/offline behavior, and symbol wording.
- [ ] **Step 3: Confirm no push/PR/merge** and report worktree/branch, spec/plan/commit IDs, implementation commits, dependency and supported scope, model/kinds/error semantics, boundaries, delegation, final test result/count, acceptance result, diff check, diff stat, status, and deferred non-blocking observations.
