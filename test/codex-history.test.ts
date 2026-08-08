import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentEvidence,
  AgentSessionRef,
} from "../src/agents/agent-history-source.js";
import {
  CodexHistorySource,
  discoverCodexSources,
  extractCodexEvidence,
  parseTranscript,
  readCodexSummary,
} from "../src/agents/codex/index.js";

const fixtureRoot = path.resolve(process.cwd(), "test/fixtures/codex");

function fixturePath(name: string): string {
  return path.join(fixtureRoot, name);
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "whyline-codex-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeTranscript(
  directory: string,
  name: string,
  records: readonly unknown[],
  trailingText = "",
): Promise<string> {
  const filePath = path.join(directory, name);
  await writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length > 0 ? "\n" : ""}${trailingText}`,
    "utf8",
  );
  return filePath;
}

function refFor(sourcePath: string, sourceKind: "active" | "archived" = "active"): AgentSessionRef {
  return { adapterId: "codex", sourcePath, sourceKind };
}

async function fixtureRef(
  t: test.TestContext,
  fixtureName: string,
  sourceKind: "active" | "archived" = "active",
): Promise<AgentSessionRef> {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "not-the-authoritative-session-id.jsonl");
  await copyFile(fixturePath(fixtureName), destination);
  return refFor(destination, sourceKind);
}

function metaRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2026-08-08T01:34:54.000Z",
    type: "session_meta",
    payload: {
      id: "filename-like-id-that-must-not-be-used",
      session_id: "synthetic-session-id",
      timestamp: "2026-08-08T01:34:54.000Z",
      cwd: "/home/alice/projects/example",
      originator: "t3code_desktop",
      source: "vscode",
      cli_version: "0.147.0",
      ...overrides,
    },
  };
}

function responseRecord(payload: Record<string, unknown>, timestamp = "2026-08-08T01:34:55.000Z"): Record<string, unknown> {
  return { timestamp, type: "response_item", payload };
}

function eventRecord(payload: Record<string, unknown>, timestamp = "2026-08-08T01:34:56.000Z"): Record<string, unknown> {
  return { timestamp, type: "event_msg", payload };
}

function evidenceOf(bundle: Awaited<ReturnType<typeof extractCodexEvidence>>, kind: AgentEvidence["kind"]): AgentEvidence[] {
  return bundle.evidence.filter((item) => item.kind === kind);
}

test("discovery is recursive, metadata-only, filename-independent, and archive-optional", async (t) => {
  const home = await temporaryDirectory(t);
  const activeNested = path.join(home, "sessions", "partition", "deeper");
  const archivedNested = path.join(home, "archived_sessions", "old", "partition");
  await mkdir(activeNested, { recursive: true });
  await mkdir(archivedNested, { recursive: true });
  await copyFile(fixturePath("rollout-cli-v0.142.5.jsonl"), path.join(activeNested, "arbitrary-active-name.jsonl"));
  await copyFile(fixturePath("rollout-t3-v0.147.0.jsonl"), path.join(activeNested, "arbitrary-t3-name.jsonl"));
  await copyFile(fixturePath("rollout-subagent-v0.147.0.jsonl"), path.join(archivedNested, "arbitrary-archived-name.jsonl"));
  await writeFile(path.join(home, "history.jsonl"), "{\"session_id\":\"prompt-index-only\"}\n", "utf8");
  await writeFile(path.join(activeNested, "history.jsonl"), "not evidence\n", "utf8");
  await writeFile(path.join(activeNested, "not-a-transcript.jsonl"), "not JSON and still discoverable\n", "utf8");

  const discovered = await discoverCodexSources({ codexHome: home });
  assert.equal(discovered.refs.length, 4);
  assert.deepEqual(
    discovered.refs.map((ref) => ref.sourceKind).sort(),
    ["active", "active", "active", "archived"],
  );
  assert.ok(discovered.refs.every((ref) => !ref.sourcePath.endsWith("history.jsonl")));
  assert.ok(discovered.refs.some((ref) => ref.sourcePath.endsWith("not-a-transcript.jsonl")));
  assert.deepEqual(discovered.diagnostics, []);

  const historyBundle = await extractCodexEvidence(refFor(path.join(home, "history.jsonl")));
  assert.equal(historyBundle.session.sessionId, null);
  assert.deepEqual(historyBundle.evidence, []);
  assert.ok(historyBundle.diagnostics.some((item) => item.kind === "unsupported-source"));

  const archiveOptionalHome = await temporaryDirectory(t);
  const archiveOptionalSessions = path.join(archiveOptionalHome, "sessions", "2026", "08", "08");
  await mkdir(archiveOptionalSessions, { recursive: true });
  await copyFile(
    fixturePath("rollout-cli-v0.142.5.jsonl"),
    path.join(archiveOptionalSessions, "active-only.jsonl"),
  );
  const sourceWithoutArchive = await discoverCodexSources({ codexHome: archiveOptionalHome });
  assert.equal(sourceWithoutArchive.availability, "available");
  assert.equal(sourceWithoutArchive.refs.length, 1);
  assert.deepEqual(sourceWithoutArchive.diagnostics, []);

  const missingHome = await discoverCodexSources({ codexHome: path.join(home, "missing-home") });
  assert.deepEqual(missingHome.refs, []);
  assert.equal(missingHome.availability, "unavailable");

  const partiallyUnreadableHome = await temporaryDirectory(t);
  await writeFile(path.join(partiallyUnreadableHome, "sessions"), "not a directory\n", "utf8");
  const readableArchivedSessions = path.join(partiallyUnreadableHome, "archived_sessions", "2026", "08", "08");
  await mkdir(readableArchivedSessions, { recursive: true });
  await copyFile(
    fixturePath("rollout-subagent-v0.147.0.jsonl"),
    path.join(readableArchivedSessions, "readable-archive.jsonl"),
  );
  const partiallyUnreadable = await discoverCodexSources({ codexHome: partiallyUnreadableHome });
  assert.equal(partiallyUnreadable.availability, "limited");
  assert.equal(partiallyUnreadable.refs.length, 1);
  assert.equal(partiallyUnreadable.refs[0]?.sourceKind, "archived");
  assert.ok(partiallyUnreadable.diagnostics.some((item) => item.kind === "unreadable-transcript"));

  const emptyHome = await temporaryDirectory(t);
  const emptyReadable = await discoverCodexSources({ codexHome: emptyHome });
  assert.equal(emptyReadable.availability, "available");
  assert.deepEqual(emptyReadable.refs, []);
  assert.deepEqual(emptyReadable.diagnostics, []);
});

test("CLI/TUI summary uses session metadata and observed-through time", async (t) => {
  const ref = await fixtureRef(t, "rollout-cli-v0.142.5.jsonl");
  const summary = await readCodexSummary(ref);

  assert.equal(summary.sessionId, "example-session");
  assert.equal(summary.startedAt, "2026-07-03T09:15:26.000Z");
  assert.equal(summary.observedThroughAt, "2026-07-03T09:15:30.000Z");
  assert.equal(summary.initialCwd, "/home/alice/projects/example");
  assert.deepEqual(summary.workingDirectories, ["/home/alice/projects/example"]);
  assert.equal(summary.originator, "codex-tui");
  assert.equal(summary.source, "cli");
  assert.equal(summary.clientVersion, "0.142.5");
  assert.equal(summary.isPartial, false);
  assert.doesNotMatch(JSON.stringify(summary), /synthetic/);
});

test("T3 and subagent summaries preserve observed fields without repository URLs or filename IDs", async (t) => {
  const t3 = await readCodexSummary(await fixtureRef(t, "rollout-t3-v0.147.0.jsonl"));
  assert.equal(t3.sessionId, "example-t3-session");
  assert.equal(t3.model, "gpt-example");
  assert.equal(t3.originator, "t3code_desktop");
  assert.equal(t3.source, "vscode");
  assert.equal(t3.transcriptGit?.branch, "main");
  assert.equal(t3.transcriptGit?.commitHash, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(t3.transcriptGit?.referenceKind, "session-head");
  assert.equal(t3.observedThroughAt, "2026-08-08T01:35:00.000Z");
  assert.doesNotMatch(JSON.stringify(t3), /repository_url|example\.invalid/);
  assert.doesNotMatch(JSON.stringify(t3), /synthetic/);

  const subagentRef = await fixtureRef(t, "rollout-subagent-v0.147.0.jsonl");
  const subagent = await readCodexSummary(subagentRef);
  assert.equal(subagent.sessionId, "example-subagent-session");
  assert.notEqual(subagent.sessionId, path.basename(subagentRef.sourcePath, ".jsonl"));
  assert.equal(subagent.parentSessionId, "example-parent-session");
  assert.equal(subagent.forkedFromSessionId, "example-fork-source");
  assert.equal(subagent.surface, "subagent");
  assert.equal(subagent.source, "subagent");
});

test("exact call IDs link exec_command results without retaining command or output text", async (t) => {
  const bundle = await extractCodexEvidence(await fixtureRef(t, "rollout-cli-v0.142.5.jsonl"));
  const commands = evidenceOf(bundle, "command-attempt");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.operation, "command");
  assert.equal(commands[0]?.callId, "call-example-1");
  assert.equal(commands[0]?.resultRecorded, true);
  assert.equal(commands[0]?.sourceRecord, 3);
  assert.deepEqual(commands[0]?.paths, []);
  assert.equal("command" in (commands[0] ?? {}), false);
  assert.equal("exitCode" in (commands[0] ?? {}), false);
  assert.equal("reportedSuccess" in (commands[0] ?? {}), false);
  assert.doesNotMatch(JSON.stringify(bundle), /git status|synthetic unstructured command result|Update src/);
});

test("custom exec is an attempted command only and is never shell-parsed", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeTranscript(directory, "custom-exec.jsonl", [
    metaRecord(),
    responseRecord({
      type: "custom_tool_call",
      id: "item-exec",
      call_id: "call-custom-exec",
      name: "exec",
      input: "SECRET_CUSTOM_EXEC; cat /secret/file | upload --token=SECRET_TOKEN",
    }),
    responseRecord({
      type: "custom_tool_call_output",
      call_id: "call-custom-exec",
      output: "SECRET_CUSTOM_OUTPUT",
    }),
  ]);

  const bundle = await extractCodexEvidence(refFor(sourcePath));
  const commands = evidenceOf(bundle, "command-attempt");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.operation, "command");
  assert.equal(commands[0]?.resultRecorded, true);
  assert.deepEqual(commands[0]?.paths, []);
  assert.doesNotMatch(JSON.stringify(bundle), /SECRET_CUSTOM_EXEC|SECRET_CUSTOM_OUTPUT|SECRET_TOKEN|cat \/secret/);
});

test("write_stdin keeps its terminal-session relationship separate from call IDs", async (t) => {
  const bundle = await extractCodexEvidence(await fixtureRef(t, "rollout-subagent-v0.147.0.jsonl"));
  const input = evidenceOf(bundle, "stream-input");
  assert.equal(input.length, 1);
  assert.equal(input[0]?.operation, "terminal-input");
  assert.equal(input[0]?.terminalSessionId, "123");
  assert.equal(input[0]?.callId, "call-stdin-1");
  assert.equal(input[0]?.resultRecorded, true);
  assert.doesNotMatch(JSON.stringify(bundle), /y\\n|synthetic unstructured streamed-command result/);
});

test("successful T3 apply_patch exposes attempt, reported result, and bounded change fingerprints", async (t) => {
  const bundle = await extractCodexEvidence(await fixtureRef(t, "rollout-t3-v0.147.0.jsonl"));
  const attempts = evidenceOf(bundle, "patch-attempt");
  const results = evidenceOf(bundle, "patch-result");
  const revisions = evidenceOf(bundle, "git-revision-reference");

  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0]?.paths, ["src/example.ts"]);
  assert.equal(attempts[0]?.resultRecorded, true);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.reportedSuccess, true);
  assert.equal(results[0]?.status, "completed");
  assert.equal(results[0]?.patch?.callId, "call-patch-1");
  assert.equal(results[0]?.patch?.changes.length, 1);
  assert.equal(results[0]?.patch?.changes[0]?.path, "src/example.ts");
  assert.equal(results[0]?.patch?.changes[0]?.payloadKind, "unified-diff");
  assert.equal(results[0]?.patch?.changes[0]?.payloadRecovered, true);
  assert.equal(results[0]?.patch?.changes[0]?.addedLineFingerprints.length, 1);
  assert.equal(results[0]?.patch?.changes[0]?.payloadFingerprint.length, 64);
  assert.equal(revisions[0]?.commitIds[0], "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(revisions[0]?.commitReferenceKind, "session-head");
  assert.equal(revisions.some((item) => item.commitReferenceKind === "produced-commit"), false);
  assert.ok(bundle.diagnostics.some((item) => item.kind === "compacted-history"));
  assert.ok(bundle.diagnostics.some((item) => item.kind === "context-compaction"));
  assert.doesNotMatch(JSON.stringify(bundle), /synthetic patch output|synthetic tool output|old|new|repository_url/);
});

test("failed patch and update/add/delete change payloads remain separate from success", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeTranscript(directory, "failed-patch.jsonl", [
    metaRecord(),
    responseRecord({
      type: "custom_tool_call",
      id: "item-patch",
      call_id: "call-failed-patch",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: src/update.ts\n*** Add File: src/add.ts\n*** Delete File: src/delete.ts\n*** End Patch",
    }),
    eventRecord({
      type: "patch_apply_end",
      call_id: "call-failed-patch",
      status: "interrupted",
      success: false,
      changes: {
        "/home/alice/projects/example/src/update.ts": {
          type: "update",
          unified_diff: "@@\n-old\n+new\n",
        },
        "/home/alice/projects/example/src/add.ts": {
          type: "add",
          content: "SECRET_ADDED_SOURCE\n",
        },
        "/home/alice/projects/example/src/delete.ts": {
          type: "delete",
          content: "SECRET_DELETED_SOURCE\n",
        },
      },
    }),
  ]);

  const bundle = await extractCodexEvidence(refFor(sourcePath));
  const attempt = evidenceOf(bundle, "patch-attempt")[0];
  const result = evidenceOf(bundle, "patch-result")[0];
  assert.deepEqual(attempt?.paths, ["src/update.ts", "src/add.ts", "src/delete.ts"]);
  assert.equal(attempt?.resultRecorded, true);
  assert.equal(result?.reportedSuccess, false);
  assert.equal(result?.status, "interrupted");
  assert.deepEqual(
    result?.patch?.changes.map((change) => change.changeType),
    ["update", "add", "delete"],
  );
  assert.ok(result?.patch?.changes.every((change) => change.payloadRecovered));
  assert.doesNotMatch(JSON.stringify(bundle), /SECRET_ADDED_SOURCE|SECRET_DELETED_SOURCE|old|new/);
});

test("unknown, compaction, rollback, abort, and unlinked results become diagnostics", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeTranscript(directory, "coverage.jsonl", [
    metaRecord(),
    { timestamp: "2026-08-08T01:34:55.000Z", type: "SECRET_UNKNOWN_TYPE", payload: { secret: "SECRET_UNKNOWN" } },
    eventRecord({ type: "SECRET_INNER_UNKNOWN_TYPE", secret: "SECRET_INNER_UNKNOWN" }),
    eventRecord({ type: "thread_rolled_back" }),
    eventRecord({ type: "turn_aborted" }),
    eventRecord({ type: "mcp_tool_call_end", call_id: "missing-call", result: { Err: "SECRET_MCP" } }),
    responseRecord({ type: "function_call_output", call_id: "missing-function-call", output: "SECRET_UNLINKED" }),
  ]);

  const bundle = await extractCodexEvidence(refFor(sourcePath));
  assert.equal(bundle.unknownRecordCount, 2);
  assert.ok(bundle.diagnostics.some((item) => item.kind === "thread-rollback"));
  assert.ok(bundle.diagnostics.some((item) => item.kind === "turn-aborted"));
  assert.ok(bundle.diagnostics.some((item) => item.kind === "unlinked-tool-result"));
  assert.ok(bundle.diagnostics.every((item) => !/[\u0000-\u001f\u007f-\u009f]/.test(JSON.stringify(item))));
  assert.doesNotMatch(JSON.stringify(bundle), /SECRET_UNKNOWN|SECRET_INNER_UNKNOWN|SECRET_MCP|SECRET_UNLINKED/);
});

test("malformed final input preserves prior evidence and reports partial coverage", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeTranscript(
    directory,
    "partial.jsonl",
    [metaRecord()],
    "{\"timestamp\":\"2026-08-08T01:34:55.000Z\",\"type\":\"response_item\"",
  );
  const bundle = await extractCodexEvidence(refFor(sourcePath));
  assert.equal(bundle.session.sessionId, "synthetic-session-id");
  assert.equal(bundle.session.observedThroughAt, "2026-08-08T01:34:54.000Z");
  assert.equal(bundle.session.isPartial, true);
  assert.ok(bundle.diagnostics.some((item) => item.kind === "partial-final-record"));
});

test("malformed non-final input is diagnostic and does not block later valid records", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = path.join(directory, "corrupt-middle.jsonl");
  await writeFile(
    sourcePath,
    `${JSON.stringify(metaRecord())}\n{malformed middle\n${JSON.stringify({
      timestamp: "2026-08-08T01:34:57.000Z",
      type: "turn_context",
      payload: { cwd: "/home/alice/projects/example", model: "gpt-after-corruption" },
    })}\n`,
    "utf8",
  );
  const bundle = await extractCodexEvidence(refFor(sourcePath));
  assert.equal(bundle.session.model, "gpt-after-corruption");
  assert.ok(bundle.diagnostics.some((item) => item.kind === "corrupt-non-final-record"));
});

test("missing session metadata is unsupported and never guessed from a filename", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeTranscript(directory, "filename-session-id.jsonl", [
    {
      timestamp: "2026-08-08T01:34:55.000Z",
      type: "turn_context",
      payload: { cwd: "/home/alice/projects/example", model: "gpt-without-meta" },
    },
  ]);
  const summary = await readCodexSummary(refFor(sourcePath));
  assert.equal(summary.sessionId, null);
  assert.equal(summary.model, "gpt-without-meta");
  assert.ok(summary.diagnostics.some((item) => item.kind === "missing-session-metadata"));
  assert.notEqual(summary.sessionId, "filename-session-id");
});

test("multiple compatible metadata records retain one authoritative session identity", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = metaRecord();
  const second = {
    ...metaRecord({ timestamp: "2026-08-08T01:34:57.000Z", cwd: "/home/alice/projects/example/subdir" }),
    timestamp: "2026-08-08T01:34:57.000Z",
  };
  const summary = await readCodexSummary(refFor(await writeTranscript(directory, "duplicate-meta.jsonl", [first, second])));
  assert.equal(summary.sessionId, "synthetic-session-id");
  assert.equal(summary.startedAt, "2026-08-08T01:34:54.000Z");
  assert.equal(summary.observedThroughAt, "2026-08-08T01:34:57.000Z");
  assert.deepEqual(summary.workingDirectories, [
    "/home/alice/projects/example",
    "/home/alice/projects/example/subdir",
  ]);
  assert.equal(summary.diagnostics.some((item) => item.kind === "conflicting-session-metadata"), false);
});

test("absolute patch paths are normalized inside the session boundary and outside paths are not retained", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeTranscript(directory, "absolute-paths.jsonl", [
    metaRecord(),
    responseRecord({
      type: "custom_tool_call",
      id: "patch-attempt",
      call_id: "call-absolute-paths",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: /home/alice/projects/example/src/inside.ts\n*** Update File: /home/alice/SECRET_OUTSIDE/secret.ts\n*** End Patch",
    }),
    eventRecord({
      type: "patch_apply_end",
      call_id: "call-absolute-paths",
      success: true,
      status: "completed",
      changes: {
        "/home/alice/projects/example/src/inside.ts": { type: "update", unified_diff: "@@\n+inside\n" },
        "/home/alice/SECRET_OUTSIDE/secret.ts": { type: "update", unified_diff: "@@\n+outside\n" },
      },
    }),
  ]);

  const bundle = await extractCodexEvidence(refFor(sourcePath));
  const result = evidenceOf(bundle, "patch-result")[0];
  assert.ok(result?.paths.includes("src/inside.ts"));
  assert.ok(result?.paths.includes("<outside-session-root>"));
  assert.doesNotMatch(JSON.stringify(bundle), /\/home\/alice\/SECRET_OUTSIDE|secret\.ts/);
});

test("source mutation during streaming is surfaced", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeTranscript(directory, "mutating.jsonl", [
    metaRecord(),
    { timestamp: "2026-08-08T01:34:55.000Z", type: "task_started", payload: { turn_id: "turn-1" } },
  ]);
  let changed = false;
  const parsed = await parseTranscript(refFor(sourcePath), {
    onRecord: async (record) => {
      if (!changed && record.recordNumber === 1) {
        changed = true;
        await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\n`, "utf8");
      }
    },
  });
  assert.equal(changed, true);
  assert.ok(parsed.diagnostics.some((item) => item.kind === "changed-during-read"));
});

test("unreadable transcripts degrade to diagnostics without filesystem or network side effects", async (t) => {
  const directory = await temporaryDirectory(t);
  const missing = refFor(path.join(directory, "does-not-exist.jsonl"));
  const bundle = await extractCodexEvidence(missing);
  assert.equal(bundle.session.sessionId, null);
  assert.deepEqual(bundle.evidence, []);
  assert.ok(bundle.diagnostics.some((item) => item.kind === "unreadable-transcript"));
});

test("agent source exposes only the staged discovery, summary, and evidence operations", async (t) => {
  const home = await temporaryDirectory(t);
  const sessions = path.join(home, "sessions", "2026", "08", "08");
  await mkdir(sessions, { recursive: true });
  await copyFile(fixturePath("rollout-cli-v0.142.5.jsonl"), path.join(sessions, "different-name.jsonl"));
  const source = new CodexHistorySource();
  const refs: AgentSessionRef[] = [];
  for await (const ref of source.discover({ historyRoot: home })) {
    refs.push(ref);
  }
  assert.equal(refs.length, 1);
  const diagnosticDiscovery = await source.discoverWithDiagnostics({ historyRoot: home });
  assert.equal(diagnosticDiscovery.availability, "available");
  assert.equal(diagnosticDiscovery.refs.length, 1);
  assert.deepEqual(diagnosticDiscovery.diagnostics, []);
  assert.equal((await source.readSummary(refs[0]!)).sessionId, "example-session");
  assert.equal((await source.extractEvidence(refs[0]!)).session.sessionId, "example-session");
});
