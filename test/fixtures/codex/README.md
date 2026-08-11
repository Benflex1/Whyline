# Codex transcript fixtures

These files are intentionally synthetic. They reproduce only envelopes and fields
observed during the Slice 0 preflight of Codex CLI 0.142.5 through 0.147.0.
They contain no copied prompts, commands, outputs, repository data, or IDs.

`rollout-t3-v0.147.0.jsonl` also contains observed compaction and structured
patch-completion shapes. `history-prompt-index-v0.147.0.jsonl` is not a rollout
transcript; it is the separate prompt-history index shape.

`rollout-durable-terminal-v0.147.0.jsonl` is a sanitized terminal-only patch
fixture: its `event_msg / patch_apply_end` is self-contained and its adjacent
`exec` record is deliberately not provenance.
