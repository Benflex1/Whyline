# Whyline

Why does this line exist?

Whyline is a local-first developer tool for investigating the provenance of a current line, range, or TypeScript/JavaScript-family symbol. It combines several bounded evidence domains:

- Git textual attribution;
- exact Git-visible ancestry;
- bounded correspondence between transformed declarations and their direct parent;
- local Codex history correlation; and
- current worktree-change correlation.

The report keeps observed facts, deterministic derivations, and conservative inference distinct. Whyline is not an authorship oracle: Git attribution is not proof of who wrote code, and a related Codex session is not automatically the cause of a commit.

## Installation

The intended v0.1.1 installation is through npm:

```sh
npm install --global @benflex/whyline
```

Whyline requires Node.js 24 or newer and Git 2.36 or newer. v0.1.1 supports Linux and macOS. Windows is explicitly unsupported and untested for this release.

For a one-shot invocation without a global install:

```sh
npx --yes @benflex/whyline src/parser.ts:42
```

## Usage

Run a line query from inside a Git worktree:

```sh
whyline src/parser.ts:42
```

The CLI accepts these forms:

```text
whyline [--details] <file>:<line>
whyline [--details] <file>:<start>-<end>
whyline [--details] --symbol <selector> <file>
whyline --help
whyline --version
```

Locations are one-based. Paths may be repository-relative or absolute, but must resolve inside the current worktree. Ranges are inclusive and bounded to 200 lines. Symbol queries resolve one exact, file-scoped declaration in TypeScript/JavaScript-family files (`.ts`, `.mts`, `.cts`, `.d.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, or `.jsx`).

Use `--details` when you need bounded forensic material such as commit metadata, changed paths, relevant hunks, ancestry proof, correlation signals, and limitations. Use `--help` for the installed command’s concise syntax and support summary; use `--version` to print the installed package version.

Codex history discovery uses `$CODEX_HOME` when it is set; otherwise it uses the normal local `~/.codex` home.

## What the result means

Whyline starts with the line’s current Git state and textual last-touch attribution. When the material is sufficient, it can additionally report:

- exact movement or copy evidence visible to Git;
- a verified direct-parent declaration correspondence for a changed declaration, while stating that the queried line itself is not an exact ancestor match;
- a conservative relationship to local Codex history when the evidence is strong and unambiguous; or
- a current worktree change, with any related Codex session presented as conservative evidence rather than authorship or causation.

An ambiguous, unavailable, limited, or missing evidence domain does not invalidate a usable Git report. Whyline fails closed rather than turning proximity, timing, similar names, or weak textual overlap into a causal claim.

## Deliberate limits

Whyline v0.1.1 does not claim authorship, causation, or semantic symbol identity across history. It does not search the web or a remote repository, fetch Git data, execute commands found in Codex transcripts, expose prompts or reasoning, maintain a persistent index, provide a web UI or daemon, or support Windows. A dirty or untracked line is not treated as Git-committed authorship; when current worktree material is sufficient, Whyline can correlate that change with local Codex history without claiming that an agent authored or caused it.

Codex correlation is local and optional. It depends on readable, supported local session history; disabled, deleted, rotated, inaccessible, truncated, or unsupported history remains unavailable or limited rather than guessed.

## Privacy and locality

Analysis is local: Whyline has no telemetry, account, or server; it does not fetch remote Git data or perform network lookups for provenance analysis; and it keeps no persistent provenance index. Reports do not dump raw prompts, reasoning, transcripts, command output, or credentials.

## Exit codes

- `0` — analysis completed, including Git-only, ambiguous, and uncommitted results;
- `2` — invalid input or unsupported target; and
- `3` — operational failure, such as Git disappearing or the repository changing during analysis.

## Development

```sh
npm install
npm run check
npm pack --dry-run --json
```

The project uses strict TypeScript, ESM, the built-in Node.js test runner, and the installed `git` executable through argv-only, read-only subprocesses. TypeScript remains a runtime dependency because symbol queries load its compiler API lazily.

## License

Whyline is released under the [MIT License](LICENSE).
