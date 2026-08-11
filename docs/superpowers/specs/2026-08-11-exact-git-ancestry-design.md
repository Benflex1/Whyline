# Exact Git-Visible Ancestry Design

**Status:** approved
**Date:** 2026-08-11
**Branch:** `feat/exact-git-ancestry`

## Goal

Extend Whyline's committed single-line analysis so it can distinguish textual last-touch from a conservatively proven older exact Git-visible predecessor, while preserving the existing Codex correlation domain and making the default CLI explanation-first.

The governing rule is to prefer no ancestry claim over a false ancestry claim. `git blame -M -C` is only a candidate generator; an ancestry claim requires a proper reachable ancestor and an independent exact block proof containing the queried line.

## Scope and boundaries

The milestone supports committed single-line queries, unchanged baseline textual blame, one movement-aware `-M -C` blame query, exact same-file and cross-file block verification, connected rename classification, concise default output, and `--details` forensic output. It does not add semantic matching, fuzzy or normalized comparison, multi-hop graphs, ranges, symbols, JSON, other agents, remote metadata, or persistent indexes.

Dirty/untracked queries that do not have committed attribution do not run ancestry. Root history reports `none / root-history-boundary`; shallow history without a complete positive proof reports `unavailable / missing-history`; missing objects and unresolved merge parent selection remain typed unavailable outcomes. Absence of a proof is never origin evidence.

## Architecture

### Ancestry domain

`src/ancestry/model.ts` owns the typed ancestry status, transition, proof, ancestor location, and bounded limitations. The result is an independent report field and does not replace or reinterpret `GitProvenance`.

`src/ancestry/exact-block-proof.ts` is a pure primitive. It receives complete current and ancestor line material, the queried current line, and the candidate ancestor line. It aligns those lines, expands a bounded contiguous block in both directions while lines remain exactly equal, and succeeds only when:

- the queried current line is inside the proof block;
- at least two unique exact lines pass the existing Whyline distinctiveness predicate;
- the block contains at least 40 alphanumeric characters;
- all required source material is marked complete.

Line comparison retains every character, including whitespace and case. The existing Codex distinctiveness predicate is extracted into a shared internal utility only if needed, with regression coverage proving its behavior is unchanged. The proof has no Git, filesystem, timestamp, similarity, or scoring dependency.

### Read-only Git tracing

`src/git/trace-line-ancestry.ts` performs the ancestry-specific Git work after authoritative baseline provenance is assembled:

1. Run exactly one `git blame --line-porcelain -M -C -L L,L T -- P` candidate query, with the existing fixed Git configuration flags permitted by the process boundary.
2. Reject equal attribution and require the candidate object `A` to be a proper reachable ancestor of `T` using Git's positive ancestry check.
3. Obtain structured candidate path/line data from porcelain output.
4. Resolve `T:P` and `A:path` through `ls-tree -z` object IDs, then read the complete blobs with `cat-file`; no revision/path concatenation is used.
5. Run the pure exact-block proof.
6. Inspect the existing connected rename evidence and classify the proven transition.

Object IDs are validated as Git-produced hexadecimal IDs before being passed back to Git. Paths remain separate argv values after `--`. All operations use the existing `GitRunner`, `shell:false`, local read-only commands, and no config writes or network operations.

The tracer returns `exact`, `uncertain`, `none`, or `unavailable`. A candidate that fails proper reachability or exact comparison is not promoted. Generic/repeated context produces typed uncertainty when the candidate block cannot satisfy the proof thresholds. A visible exact predecessor in a shallow repository is allowed only with a visible-history limitation and is never called an ultimate origin.

### Provenance integration

`WhylineReport` gains ancestry for committed reports. The pipeline continues to resolve location, baseline blame, commit inspection, parent selection, changed paths, and relevant hunk first. Only then does it launch ancestry and Codex correlation as independent operations. The correlation target is built from the same baseline provenance as before, and ancestry cannot modify its target commit, score, confidence, candidate cap, coverage, or result status.

The final stability check remains the authority for repository and target mutation. Ancestry failures that are part of the frozen typed evidence model become report results; unexpected process failures retain existing operational error behavior where they affect analysis safety.

### Explanation-first CLI

`src/cli/parse-arguments.ts` accepts either one location or `--details` followed by one location. Unknown or repeated flags remain usage errors with exit code 2. `src/cli/render-summary.ts` renders the bounded default explanation: location, textual last-touch, Git ancestry, and concise AI provenance. `renderText` or an equivalent details renderer retains the existing repository state, metadata, parent, changed paths, hunk, Codex evidence/coverage, and limitations under `--details` and adds ancestry candidate, verified ancestor, transition, proof summary, and limitations.

Default output never says “originated here” or “original commit.” It uses “not established” for absence and an explicit “uncertain” explanation when Git suggested movement but exact verification failed. Existing privacy-safe Codex rendering remains bounded and excludes prompts, reasoning, commands, transcript paths, and raw patch payloads.

## Testing strategy

Testing follows red-green-refactor at each behavior boundary:

- pure proof tests cover aligned and expanded blocks, query containment, unique distinctive-line and alphanumeric thresholds, repeated/generic lines, whitespace-only differences, partial transformations, incomplete material, and the context bound;
- real-Git fixture tests cover same-file movement, cross-file move/copy, rename, unchanged attribution, transformed and generic candidates, root, shallow history, missing objects where practical, merge ambiguity, Unicode paths, and SHA-256 repositories when available;
- report tests verify ancestry runs only after committed baseline provenance, is independent from Codex decisions, is skipped for dirty/untracked attribution, and preserves mutation/read-only safety;
- CLI tests cover concise exact/none/uncertain/unavailable output, Codex matched/ambiguous/limited coverage, privacy bounds, `--details`, and flag errors;
- one disposable real-Git end-to-end scenario verifies the textual refactor commit, older exact ancestor, concise output, and details evidence together.

At completion the bounded acceptance sequence is one full `npm run check`, one `git diff --check`, the disposable end-to-end scenario, and one final diff inspection against the frozen criteria.

## Deferred work

JSON, ranges, symbols/functions, semantic or transformed ancestry, whitespace/case normalization, repeated `-C`, multi-hop ancestry graphs, ancestry caches/indexes, remote/PR metadata, and additional agent adapters remain explicitly deferred.
