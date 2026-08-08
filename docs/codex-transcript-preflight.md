# Codex transcript preflight (Slice 0)

**Observed on:** 2026-08-08  
**Codex executable:** `codex-cli 0.147.0`  
**Retained rollout versions sampled:** 0.142.5, 0.144.1, 0.144.3–0.144.6, 0.145.0, 0.146.0, and 0.147.0.

This is an empirical, read-only sample of the local profile. It is deliberately
not a public-schema claim. The supporting fixtures are synthetic:
[`test/fixtures/codex`](../test/fixtures/codex).

## Environment

The effective home for this invocation is the default `<home>/.codex`: no
`CODEX_HOME` environment override was present. `config.toml` did not contain
`history.*` or a persistence-mode setting. Per-session metadata reported
`history_mode: "legacy"` in 177 retained sessions; its semantics cannot be
established from the data alone. The same home also contains SQLite state files,
but this preflight did not read them because rollout JSONL supplied the needed
observations.

Observed storage locations:

| Store | Observed layout / role | Count |
| --- | --- | ---: |
| Active rollouts | `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<UTC-start>-<id>.jsonl` | 188 files |
| Archived rollouts | `<CODEX_HOME>/archived_sessions/` | directory absent; 0 sampled |
| Prompt history | `<CODEX_HOME>/history.jsonl` | 391 entries, 2.54 MiB |

The date directories and filename timestamp/ID convention are observed, not a
contract. A rollout's filename ID matched `session_meta.payload.session_id` in
181/191 metadata records; the seven subagent transcripts deliberately differed,
and three other CLI/TUI records also differed. Do not derive identity from the
filename. Every file had usable metadata; 186 had one `session_meta`, three had
two identical `session_id` metadata records, and none had conflicting session IDs.

`history.jsonl` is a compact prompt index, not a complete transcript: every
sampled row was `{session_id, ts, text}`. It has no assistant, tool, result,
cwd, or envelope records. It covered 141 of 181 rollout session IDs and therefore
is neither complete nor sufficient for Whyline evidence. Its `ts` was an integer
epoch-millisecond value; rollout timestamps were ISO-8601 UTC strings.

Observed surfaces sharing this home were CLI/TUI (`originator: codex-tui`,
`source: cli`, 144 user sessions), T3 Code desktop / VS Code (`originator:
t3code_desktop`, `source: vscode`, 40 sessions), and seven subagent transcripts.
No standalone `codex exec` session was positively identifiable in the retained
sample; custom tools named `exec` are T3 tool calls, not evidence of the
`codex exec` product surface. No CLI/IDE/desktop cross-surface experiment was
performed, so shared-home behavior is observed only for the local data already
present in this home.

## Format matrix

Every observed rollout line has an outer JSON object with `timestamp`, `type`,
and `payload`. `timestamp` parsed as UTC for all 121,408 sampled rollout records
and was nondecreasing within each file. It is a record timestamp, not a reliable
session end time. Use the first `session_meta` timestamp as the observed start;
use the last valid record timestamp only as an *observed-through* bound.

| Variant | Scope | Important shapes |
| --- | --- | --- |
| CLI/TUI user rollout | 0.142.5–0.147.0 | `session_meta`; `event_msg`; `response_item`; `turn_context`; optional `compacted` |
| T3 / VS Code rollout | 0.144.1–0.147.0 | Same outer envelope; adds observed `world_state`, `thread_settings_applied`, custom `exec`, `apply_patch`, and `patch_apply_end` activity |
| Subagent rollout | 0.144.3–0.147.0 | Separate JSONL file. `session_meta.source.subagent.thread_spawn`, `thread_source: subagent`, `parent_thread_id`, and sometimes `forked_from_id`; filename ID need not equal session ID |
| Prompt history index | retained current profile | No outer envelope: `{session_id: string, ts: number, text: string}` |

Recognized discriminators and minimum useful fields:

| Outer `type` | Payload discriminator / fields | Whyline use |
| --- | --- | --- |
| `session_meta` | `session_id`, `id`, `timestamp`, `cwd`, `cli_version`, `originator`, `source`; newer variants can add `git`, `history_mode`, `forked_from_id`, `parent_thread_id` | session identity and initial context |
| `turn_context` | `cwd`, `model`, `turn_id`, policy/context fields | later context; model observed here, not reliably in metadata |
| `event_msg` | `payload.type`: `user_message`, `agent_message`, `task_started`, `task_complete`, `token_count`, `context_compacted`, `patch_apply_end`, `mcp_tool_call_end`, `thread_rolled_back`, `thread_settings_applied`, `turn_aborted` | tool completion / diagnostics; do not expose message text |
| `response_item` | `payload.type`: `message`, `reasoning`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, plus search calls/outputs | tool call/result linkage |
| `compacted` | `window_id`, `previous_window_id`, `replacement_history`, `message` | explicit coverage-loss warning |
| `world_state` | `state`, `full` | unknown/non-evidence context; skip/count |

No direct file-read or direct file-write tool was observed. File reads were only
indirectly possible through shell/custom-code command text and output, neither of
which is a safe structured file-read contract. MCP completion was observed as
`event_msg/mcp_tool_call_end` with `call_id`, an invocation `{server, tool,
arguments}`, and `result.Ok` or `result.Err`; no filesystem-specific MCP tool was
observed.

## Session identity and repository context

| Field | Status | Observed source / rule |
| --- | --- | --- |
| Session ID | strong | `session_meta.payload.session_id`; require it, do not trust filename |
| Creation/start | strong | `session_meta.payload.timestamp` (also outer timestamp) |
| Last/end | derived / limited | last valid record timestamp; `task_complete` is turn completion only |
| Initial cwd | strong | `session_meta.payload.cwd` in every sampled rollout |
| Later cwd | variant-specific | `turn_context.cwd` and `thread_settings_applied.thread_settings.cwd`; no sampled session changed cwd |
| Model | variant-specific | `turn_context.model`; metadata did not have a model field |
| Client/surface/version | variant-specific | `originator`, `source`, `cli_version` metadata |
| Parent/fork | subagent-only observed | `parent_thread_id`, `forked_from_id`, and nested `source.subagent.thread_spawn.parent_thread_id` |
| Git branch/head/repository URL | optional, privacy-sensitive | newer `session_meta.payload.git`; fields observed were branch, commit hash, optional repository URL |
| Common Git directory/worktree identity | unavailable | no observed field provided it |

The `git` metadata can support a commit-SHA reference, but its optional URL must
not be retained or rendered. Cwd is a historical path, not a durable repository
identity. No linked worktree or Codex-managed worktree path was positively
identified; do not claim special worktree support from this sample.

## Tool and evidence mapping

| Whyline evidence | Available? | Source record | Reliability |
| --- | --- | --- |
| Command attempt | yes | `response_item/function_call`, `name: exec_command`, JSON string `arguments.cmd`; or custom `exec.input` raw string | strong for recorded attempt; command text is untrusted and may contain secrets |
| Command cwd | sometimes | `exec_command.arguments.workdir` | structured when present; never infer for custom `exec` |
| Streamed command input | yes | `function_call` `name: write_stdin`, JSON `arguments.session_id`/`chars` | links to terminal session number, not a transcript call ID |
| Command result linkage | yes | matching `function_call_output.call_id` / `custom_tool_call_output.call_id` | strong: all 26,406 sampled outputs matched a known call ID in the scan |
| Shell exit status | no stable field | output is an unstructured string | unavailable as a parser invariant; 114 outputs merely contained exit-code-like text |
| Git command / SHA output | partial | recorded command text; unstructured output | attempt is usable; SHA/output extraction only conservative and diagnostic |
| Test/build command | partial | recorded command text | classify conservatively; no structured pass/fail outcome |
| Patch attempt | yes | `response_item/custom_tool_call`, `name: apply_patch`, raw `input` | full patch input present in sampled T3 shape |
| Patch reported success | yes | `event_msg/patch_apply_end` joined by `call_id`; `success: true`, `status: completed` | strong for tool-reported success, not final repository state |
| Patch change payload | yes | `patch_apply_end.changes[path]` | 4,204 updates with `unified_diff`; 678 adds / 79 deletes with `{content, type}`; absolute map keys observed |
| Direct file read/write | not observed | — | do not fabricate normalized `file-read` / generic file-write evidence |
| MCP operation | partial | `event_msg/mcp_tool_call_end` | invocation/result is structured, but no filesystem operation observed |
| Subagent operation | yes, separate | subagent's own rollout plus parent/fork metadata | preserve relation; do not merge its record sequence into root |

`exec_command.arguments` was JSON text, not argv: sampled shapes included `cmd`,
`workdir`, optional `yield_time_ms`, `max_output_tokens`, `login`, `tty`, and
approval fields. `write_stdin.arguments` was also JSON text. Custom `exec.input`
was non-JSON code text. Never shell-parse either command form or execute it.

The structured patch payload makes distinctive added-line/hunk overlap practical
for `patch_apply_end` **updates** and, with a separate post-image rule, `add`
events. It is not available for generic commands, direct edits, or arbitrary MCP
writes. Patch overlap must therefore be optional, source-labelled evidence—not a
universal correlation requirement.

## Parser invariants

1. Discover only readable `*.jsonl` files recursively below `sessions` and,
   when it exists, `archived_sessions`; treat both directory layout and file
   naming as discovery hints, not schema.
2. Stream one line at a time. Parse outer `type` and `payload.type`; retain a
   record number and outer timestamp, but cap all string retention.
3. Establish a session only from the first usable `session_meta.session_id`.
   A file without one is unsupported, not a guessed session from its filename.
4. Link calls/results exclusively by exact `call_id`. A result after a matching
   call means *reported result*, never confirmed repository state.
5. For `apply_patch`, join the custom call and `patch_apply_end` by `call_id`.
   Report attempt, reported success, and recovered change payload as separate
   facts. Absolute paths in `changes` are sensitive inputs and must be normalized
   in-memory only.
6. Ignore unknown types safely, increment `unknownRecordCount`, and surface it
   in coverage diagnostics. Treat malformed final input as a truncation warning;
   malformed non-final input is a corruption warning.
7. Treat `compacted`, `context_compacted`, `thread_rolled_back`, `turn_aborted`,
   and tool-output caps as limitations. Only the first two and rollback/abort
   markers were observed; explicit output-truncation markers were not.
8. Do not use `history.jsonl` for provenance extraction. It is prompt-bearing and
   incomplete; at most it is an optional, privacy-preserving discovery aid.

## Compaction, archival, concurrency, and unknowns

91 `compacted` records and matching `context_compacted` events were observed;
their summary/replacement fields themselves contain sensitive transcript text.
Five `thread_rolled_back` and turn-abort records were observed. No malformed or
partial trailing JSONL record was found in this snapshot. Writer lock files were
present for active sessions, so concurrent append is plausible, but atomic
rotation behavior was not tested. The production reader should reopen/stat after
its scan and mark a changed file or invalid final line as incomplete rather than
failing the entire source.

No archived transcript, deleted/rotated transcript, explicit history-size cap,
`history.persistence = none`, explicit output-spill file, or standalone `codex
exec` transcript was observed. These are **not observed**, not globally
unsupported. The 0.142.5–0.147.0 samples showed one compatible envelope family;
there is no evidence here for older or future schemas.

## Privacy and redaction rules

The following record types can contain complete prompts, source code, absolute
paths, commands, secrets, environment assignments, credentials, tokens, and tool
output: `user_message`, `agent_message`, `message`, `reasoning`, all call
arguments/input/output, `patch_apply_end`, `compacted`, `world_state`,
`turn_context`, `session_meta.git.repository_url`, and `history.jsonl.text`.

By default the adapter must retain and display only minimal derived evidence:
session ID (or a safe short form), timestamps, normalized target-relative paths,
tool class, call ID, reported-success boolean, exit status only when later
structured, commit IDs, and a non-reversible patch fingerprint. Do not render raw
prompts, tool output, commands, diff text, absolute paths outside the selected
worktree, repository URLs, environment assignments, or compacted summaries.
Strip control characters and apply byte limits before logging diagnostics.

## Scan benchmarks

One warm-cache measurement on this local profile:

| Measurement | Result |
| --- | ---: |
| Active rollouts / archived rollouts | 188 / 0 |
| Active rollout bytes | 309,378,295 bytes (295.0 MiB) |
| `history.jsonl` | 391 rows, 2.54 MiB |
| Recursive candidate discovery (names/stats only) | 2.58 ms |
| Read/parse first metadata line for all active files | 21.30 ms |
| Full parse of five largest candidates | 45.9 MiB, 15,292 records, 314.94 ms |

On-demand staged scanning remains viable: candidate discovery and header
summaries are cheap, while full parsing should remain limited to eligible
candidates. These are a single warm-cache snapshot, not a latency commitment.

## Codex preflight question coverage

| # | Finding |
| ---: | --- |
| 1 | Default `<home>/.codex` was effective; CLI/TUI and T3/VS Code records coexist there. No active cross-surface experiment or standalone exec sample was available. |
| 2 | Date-partitioned `sessions/YYYY/MM/DD/rollout-...jsonl` was observed; names/partitions are incidental discovery hints. No archive layout was present. |
| 3 | `history.jsonl` is an incomplete, prompt-bearing index, not a transcript. |
| 4 | `session_id`, start, initial cwd, version and surface are in `session_meta`; model/cwd updates and parent/fork are variant-specific as described above. |
| 5 | Rollout ISO UTC timestamps were nondecreasing; only an observed-through bound, not an end time, is reliable. |
| 6 | Cwd fields exist in metadata/context/settings; no cwd transition or linked/Codex-managed worktree was observed. |
| 7 | The format matrix lists every locally observed outer/payload discriminator relevant to messages, reasoning, tools, compaction, and errors/aborts. |
| 8 | Exact `call_id` links calls to results. Shell exit status has no structured field. |
| 9 | `exec_command`, `write_stdin`, custom `exec`, `apply_patch`, MCP completion, and subagents were observed. Shell aliases, direct file tools, and MCP filesystem operations were not. |
| 10 | Function arguments are JSON strings (including a shell `cmd`, not argv); custom exec is raw non-JSON input. |
| 11 | Structured full patch input and `patch_apply_end` changes/success were observed; this distinguishes attempt from reported success. |
| 12 | Compaction is explicit. Output/spill/redaction marker behavior was not observed; outputs are raw sensitive strings. |
| 13 | Fork/parent fields and separate subagent files were observed. Archive/deletion behavior was not; resume is only inferred from fork metadata, not separately sampled. |
| 14 | No partial tail was observed. Active writer locks make append plausible; rotation atomicity is unknown. |
| 15 | The sampled 0.142.5–0.147.0 family is compatible, with newer T3/subagent metadata and events noted in the matrix. |
| 16 | Prompts, source, paths, commands, output, environment data, and credentials may occur in the listed record types; default redaction rules are specified. |
| 17 | Optional metadata and command text can carry Git branch/SHA, but no common Git directory and no structured command-success proof were observed. |
| 18 | Counts, bytes, and three scan timings are reported above. |
| 19 | No config key or local sample for `history.persistence = none` / `history.max_bytes` was found; mark such stores unavailable/limited rather than infer behavior. |
| 20 | The installed CLI exposes resume/archive/delete/unarchive/fork, but no public local read/export API was found in its help or the locally observed store. OpenAI documentation retrieved through Context7 describes rollout JSONL plus SQLite metadata, while the architecture's warning that transcript format is not stable remains applicable; use the narrow, version-labelled parser rather than treat this as an API. |

## Architecture impact

**Required revisions before implementation:**

1. Narrow normalized `file-read` and generic `file-write` claims: they were not
   observed as structured Codex events. Add an `operation-reported-success`
   distinction, and make command/test success optional/unavailable unless a
   future schema provides structured status.
2. Keep patch/hunk overlap, but gate it on `patch_apply_end` change payloads.
   Add/delete shapes need distinct fingerprint logic; other tools provide no
   reliable patch payload.
3. Treat a transcript `git.commit_hash` as optional SHA evidence and exclude
   `repository_url`; it does not establish `commonGitDir`. Retain the existing
   Git-side worktree mapping requirement.
4. Change summary extraction to read `session_meta`, not filename headers, and
   represent subagents as separate sessions with explicit relations.
5. Expose `observedThroughAt`, not `endedAt`, unless a later verified terminal
   record contract is added. Keep compaction/rollback/aborted flags and add a
   changed-during-read / partial-final-line diagnostic.

The staged `discover` → `readSummary` → `extractEvidence` design remains sound,
as does no persistent index. `AgentHistorySource` should gain explicit coverage
diagnostics for unknown records, compaction, rollback/abort, unreadable files,
and concurrent/partial reads. Git ↔ Codex correlation remains conservative: cwd
and optional commit references are eligibility signals, not repository identity;
structured patch overlap is the strongest non-SHA content signal.

## Slice 0 verdict

**PASS WITH REVISIONS** — the observed 0.142.5–0.147.0 rollout family provides
stable-enough empirical contracts for an adapter: metadata, call/result IDs,
subagent relationships, timestamps, and successful patch completion with usable
diff/content data. The plan must first stop promising structured generic file
reads/writes and shell/test exit status, and it must make patch overlap
variant-specific. No archived or standalone `codex exec` sample exists locally,
so those paths must deliberately degrade rather than be guessed.

## Implementation handoff status

The adapter described by this preflight is now implemented and verified against
the synthetic fixtures. Its discovery, streaming parser, privacy diagnostics,
and normalized evidence remain intentionally separate from Git analysis. The
next handoff is the conservative correlation slice, which must consume these
normalized outputs without parsing transcripts in the Git subsystem.
