import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

import type {
  AgentDiagnostic,
  AgentRelevanceCoverageReason,
  AgentSessionRef,
  AgentSessionSummary,
  AgentSourceSignature,
} from "../agent-history-source.js";
import {
  DEFAULT_MAX_JSONL_LINE_BYTES,
  diagnostic,
  getRecord,
  isRecord,
  normalizeTimestamp,
  safeAbsolutePath,
  safeCommitId,
  safeToken,
  type JsonRecord,
} from "./safe.js";

export interface TranscriptRecord {
  readonly recordNumber: number;
  readonly timestamp?: string | undefined;
  readonly type: string;
  readonly payload: JsonRecord;
}

export interface TranscriptRecordContext {
  readonly session: AgentSessionSummary;
  /** The latest cwd from a supported structured transcript record. */
  readonly effectiveCwd: string | undefined;
  addDiagnostic(value: AgentDiagnostic): void;
  addRelevanceReason(value: AgentRelevanceCoverageReason): void;
}

export type TranscriptRecordVisitor = (
  record: TranscriptRecord,
  context: TranscriptRecordContext,
) => void | Promise<void>;

export interface ParseTranscriptOptions {
  readonly maxJsonlLineBytes?: number;
  readonly mode?: "summary" | "evidence";
  readonly onRecord?: TranscriptRecordVisitor;
}

export interface ParsedTranscript {
  readonly summary: AgentSessionSummary;
  readonly diagnostics: readonly AgentDiagnostic[];
  readonly unknownRecordCount: number;
  readonly recordsSeen: number;
  readonly bytesRead: number;
  readonly sourceSignature: AgentSourceSignature | null;
  readonly relevanceReasons: readonly AgentRelevanceCoverageReason[];
}

type FileSignature = AgentSourceSignature;

const KNOWN_OUTER_TYPES = new Set([
  "session_meta",
  "event_msg",
  "response_item",
  "turn_context",
  "compacted",
  "world_state",
]);

const KNOWN_EVENT_TYPES = new Set([
  "user_message",
  "agent_message",
  "task_started",
  "task_complete",
  "token_count",
  "context_compacted",
  "patch_apply_end",
  "mcp_tool_call_end",
  "thread_rolled_back",
  "thread_settings_applied",
  "turn_aborted",
]);

const KNOWN_RESPONSE_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "web_search_call",
  "web_search_call_output",
  "file_search_call",
  "file_search_call_output",
]);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readFileSignature(sourcePath: string): Promise<FileSignature | undefined> {
  try {
    const metadata = await stat(sourcePath, { bigint: true });
    return {
      size: Number(metadata.size),
      mtimeNs: metadata.mtimeNs,
      inode: Number(metadata.ino),
      device: Number(metadata.dev),
    };
  } catch {
    return undefined;
  }
}

function signaturesDiffer(left: FileSignature, right: FileSignature): boolean {
  return left.size !== right.size
    || left.mtimeNs !== right.mtimeNs
    || left.inode !== right.inode
    || left.device !== right.device;
}

class SummaryBuilder {
  private sessionId: string | null = null;
  private startedAt: string | undefined;
  private observedThroughAt: string | undefined;
  private initialCwd: string | undefined;
  private effectiveCwd: string | undefined;
  private readonly workingDirectories: string[] = [];
  private adapterSchema = "codex-rollout-envelope";
  private surface: string | undefined;
  private originator: string | undefined;
  private source: string | undefined;
  private clientVersion: string | undefined;
  private model: string | undefined;
  private parentSessionId: string | undefined;
  private forkedFromSessionId: string | undefined;
  private transcriptGit: {
    branch?: string;
    commitHash?: string;
    referenceKind?: "session-head";
  } | undefined;
  private partial = false;
  private readonly diagnostics: AgentDiagnostic[] = [];

  public constructor(private readonly ref: AgentSessionRef) {}

  public markPartial(): void {
    this.partial = true;
  }

  public addDiagnostic(value: AgentDiagnostic): void {
    this.diagnostics.push(value);
  }

  public observeTimestamp(timestamp: string | undefined): void {
    if (timestamp !== undefined) {
      this.observedThroughAt = timestamp;
    }
  }

  public observeRecord(record: TranscriptRecord): void {
    this.observeTimestamp(record.timestamp);

    switch (record.type) {
      case "session_meta":
        this.observeSessionMeta(record.payload, record.timestamp, record.recordNumber);
        break;
      case "turn_context":
        this.observeTurnContext(record.payload);
        break;
      case "event_msg":
        this.observeEventMessage(record.payload, record.recordNumber);
        break;
      case "compacted":
        this.addDiagnostic(diagnostic("compacted-history", record.recordNumber));
        this.markPartial();
        break;
      default:
        break;
    }
  }

  public currentEffectiveCwd(): string | undefined {
    return this.effectiveCwd;
  }

  public snapshot(): AgentSessionSummary {
    const optional: {
      -readonly [Key in keyof AgentSessionSummary]?: AgentSessionSummary[Key]
    } = {};
    if (this.startedAt !== undefined) optional.startedAt = this.startedAt;
    if (this.observedThroughAt !== undefined) optional.observedThroughAt = this.observedThroughAt;
    if (this.initialCwd !== undefined) optional.initialCwd = this.initialCwd;
    if (this.adapterSchema.length > 0) optional.adapterSchema = this.adapterSchema;
    if (this.surface !== undefined) optional.surface = this.surface;
    if (this.originator !== undefined) optional.originator = this.originator;
    if (this.source !== undefined) optional.source = this.source;
    if (this.clientVersion !== undefined) optional.clientVersion = this.clientVersion;
    if (this.model !== undefined) optional.model = this.model;
    if (this.parentSessionId !== undefined) optional.parentSessionId = this.parentSessionId;
    if (this.forkedFromSessionId !== undefined) optional.forkedFromSessionId = this.forkedFromSessionId;
    if (this.transcriptGit !== undefined) optional.transcriptGit = this.transcriptGit;

    return {
      ref: this.ref,
      sessionId: this.sessionId,
      workingDirectories: [...this.workingDirectories],
      isPartial: this.partial,
      diagnostics: [...this.diagnostics],
      ...optional,
    };
  }

  private addWorkingDirectory(value: unknown): void {
    const cwd = safeAbsolutePath(value);
    if (cwd !== undefined && !this.workingDirectories.includes(cwd)) {
      this.workingDirectories.push(cwd);
    }
  }

  private observeEffectiveCwd(value: unknown): void {
    const cwd = safeAbsolutePath(value);
    if (cwd !== undefined) {
      this.effectiveCwd = cwd;
    }
  }

  private observeSessionMeta(
    payload: JsonRecord,
    outerTimestamp: string | undefined,
    recordNumber: number,
  ): void {
    const sessionId = safeToken(payload.session_id, 256);
    if (sessionId === undefined) {
      return;
    }

    if (this.sessionId !== null && this.sessionId !== sessionId) {
      this.addDiagnostic(diagnostic("conflicting-session-metadata", recordNumber));
      return;
    }

    const firstMetadata = this.sessionId === null;
    this.sessionId = sessionId;
    if (firstMetadata) {
      this.startedAt = normalizeTimestamp(payload.timestamp) ?? outerTimestamp;
    }

    const cwd = safeAbsolutePath(payload.cwd);
    if (this.initialCwd === undefined && cwd !== undefined) {
      this.initialCwd = cwd;
    }
    this.observeEffectiveCwd(cwd);
    this.addWorkingDirectory(cwd);

    const originator = safeToken(payload.originator);
    if (this.originator === undefined && originator !== undefined) {
      this.originator = originator;
    }

    const sourceValue = payload.source;
    if (typeof sourceValue === "string") {
      const source = safeToken(sourceValue);
      if (this.source === undefined && source !== undefined) {
        this.source = source;
      }
    } else if (isRecord(sourceValue)) {
      const subagent = getRecord(sourceValue, "subagent");
      if (subagent !== undefined && this.source === undefined) {
        this.source = "subagent";
      }
      const spawn = subagent === undefined ? undefined : getRecord(subagent, "thread_spawn");
      this.observeParentFields(payload, spawn);
    }

    const threadSource = safeToken(payload.thread_source);
    if (threadSource === "subagent") {
      this.surface = "subagent";
    } else if (this.surface === undefined && this.originator !== undefined) {
      this.surface = this.originator;
    }

    const clientVersion = safeToken(payload.cli_version);
    if (this.clientVersion === undefined && clientVersion !== undefined) {
      this.clientVersion = clientVersion;
    }
    this.observeParentFields(payload);
    this.observeGit(payload);
  }

  private observeParentFields(
    primary: JsonRecord,
    secondary?: JsonRecord,
  ): void {
    const parent = safeToken(primary.parent_thread_id)
      ?? (secondary === undefined ? undefined : safeToken(secondary.parent_thread_id));
    if (this.parentSessionId === undefined && parent !== undefined) {
      this.parentSessionId = parent;
    }

    const forkedFrom = safeToken(primary.forked_from_id);
    if (this.forkedFromSessionId === undefined && forkedFrom !== undefined) {
      this.forkedFromSessionId = forkedFrom;
    }
  }

  private observeGit(payload: JsonRecord): void {
    const git = getRecord(payload, "git");
    if (git === undefined) {
      return;
    }

    const branch = safeToken(git.branch, 512);
    const commitHash = safeCommitId(git.commit_hash);
    if (branch === undefined && commitHash === undefined) {
      return;
    }

    this.transcriptGit = {
      ...(this.transcriptGit ?? {}),
      ...(branch === undefined ? {} : { branch }),
      ...(commitHash === undefined ? {} : { commitHash }),
      ...(commitHash === undefined ? {} : { referenceKind: "session-head" as const }),
    };
  }

  private observeTurnContext(payload: JsonRecord): void {
    this.observeEffectiveCwd(payload.cwd);
    this.addWorkingDirectory(payload.cwd);
    const model = safeToken(payload.model, 256);
    if (model !== undefined) {
      this.model = model;
    }
  }

  private observeEventMessage(payload: JsonRecord, recordNumber: number): void {
    const eventType = safeToken(payload.type);
    switch (eventType) {
      case "context_compacted":
        this.addDiagnostic(diagnostic("context-compaction", recordNumber));
        this.markPartial();
        break;
      case "thread_rolled_back":
        this.addDiagnostic(diagnostic("thread-rollback", recordNumber));
        this.markPartial();
        break;
      case "turn_aborted":
        this.addDiagnostic(diagnostic("turn-aborted", recordNumber));
        this.markPartial();
        break;
      case "thread_settings_applied": {
        const settings = getRecord(payload, "thread_settings");
        this.observeEffectiveCwd(payload.cwd);
        this.observeEffectiveCwd(settings?.cwd);
        this.addWorkingDirectory(payload.cwd);
        this.addWorkingDirectory(settings?.cwd);
        break;
      }
      default:
        break;
    }
  }
}

function addUnknownDiagnostic(
  builder: SummaryBuilder,
  recordNumber: number,
  detail: "unknown outer record" | "unknown event record" | "unknown response record",
): number {
  builder.addDiagnostic(diagnostic("unknown-record", recordNumber, detail));
  return 1;
}

function extractJsonStringField(
  line: string,
  key: string,
  startAt = 0,
): string | undefined {
  const keyToken = `"${key}"`;
  let keyIndex = line.indexOf(keyToken, startAt);
  while (keyIndex >= 0) {
    let cursor = keyIndex + keyToken.length;
    while (/\s/.test(line[cursor] ?? "")) cursor += 1;
    if (line[cursor] !== ":") {
      keyIndex = line.indexOf(keyToken, keyIndex + 1);
      continue;
    }
    cursor += 1;
    while (/\s/.test(line[cursor] ?? "")) cursor += 1;
    if (line[cursor] !== '"') {
      keyIndex = line.indexOf(keyToken, keyIndex + 1);
      continue;
    }
    const valueStart = cursor;
    cursor += 1;
    let escaped = false;
    for (; cursor < line.length; cursor += 1) {
      const character = line[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        try {
          const parsed: unknown = JSON.parse(line.slice(valueStart, cursor + 1)) as unknown;
          return typeof parsed === "string" ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }
  return undefined;
}

function payloadStart(line: string): number {
  const payloadKey = line.indexOf('"payload"');
  return payloadKey < 0 ? -1 : line.indexOf("{", payloadKey);
}

function parseSummaryPayload(line: string, type: string): JsonRecord | undefined {
  if (type === "session_meta" || type === "turn_context") {
    try {
      const parsed: unknown = JSON.parse(line) as unknown;
      return isRecord(parsed) && isRecord(parsed.payload) ? parsed.payload : undefined;
    } catch {
      return undefined;
    }
  }

  const start = payloadStart(line);
  if (start < 0) {
    return type === "compacted" || type === "world_state" ? {} : undefined;
  }

  const payloadType = extractJsonStringField(line, "type", start);
  if ((type === "event_msg" || type === "response_item") && payloadType === undefined) {
    return undefined;
  }

  const payload: JsonRecord = {};
  if (payloadType !== undefined) {
    payload.type = payloadType;
  }
  if (type === "event_msg" && payloadType === "thread_settings_applied") {
    const cwd = extractJsonStringField(line, "cwd", start);
    if (cwd !== undefined) {
      payload.cwd = cwd;
      payload.thread_settings = { cwd };
    }
  }
  return payload;
}

function parseSummaryOuterRecord(
  line: string,
  recordNumber: number,
  finalLine: boolean,
  builder: SummaryBuilder,
  maxLineBytes: number,
): TranscriptRecord | undefined {
  if (line.length === 0 || Buffer.byteLength(line, "utf8") > maxLineBytes) {
    builder.addDiagnostic(
      diagnostic(finalLine ? "partial-final-record" : "corrupt-non-final-record", recordNumber, "record unavailable"),
    );
    if (finalLine) builder.markPartial();
    return undefined;
  }

  // Validate the trailing record completely so a concurrent partial append is
  // never presented as a stable summary. Earlier records are header-scanned;
  // full evidence extraction performs complete JSON validation for all lines.
  if (finalLine) {
    try {
      JSON.parse(line);
    } catch {
      builder.addDiagnostic(diagnostic("partial-final-record", recordNumber, "invalid JSON"));
      builder.markPartial();
      return undefined;
    }
  }

  const type = extractJsonStringField(line, "type");
  const payload = type === undefined ? undefined : parseSummaryPayload(line, type);
  if (type === undefined || payload === undefined) {
    builder.addDiagnostic(
      diagnostic(finalLine ? "partial-final-record" : "corrupt-non-final-record", recordNumber, "invalid envelope"),
    );
    if (finalLine) builder.markPartial();
    return undefined;
  }

  const rawTimestamp = extractJsonStringField(line, "timestamp");
  const timestamp = normalizeTimestamp(rawTimestamp);
  if (timestamp === undefined) {
    builder.addDiagnostic(diagnostic("invalid-timestamp", recordNumber));
  }
  return { recordNumber, timestamp, type, payload };
}

function parseOuterRecord(
  line: string,
  recordNumber: number,
  finalLine: boolean,
  builder: SummaryBuilder,
  maxLineBytes: number,
  summaryOnly: boolean,
): TranscriptRecord | undefined {
  if (summaryOnly) {
    return parseSummaryOuterRecord(line, recordNumber, finalLine, builder, maxLineBytes);
  }
  if (line.length === 0 || Buffer.byteLength(line, "utf8") > maxLineBytes) {
    builder.addDiagnostic(
      diagnostic(finalLine ? "partial-final-record" : "corrupt-non-final-record", recordNumber, "record unavailable"),
    );
    if (finalLine) {
      builder.markPartial();
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    builder.addDiagnostic(
      diagnostic(finalLine ? "partial-final-record" : "corrupt-non-final-record", recordNumber, "invalid JSON"),
    );
    if (finalLine) {
      builder.markPartial();
    }
    return undefined;
  }

  if (!isRecord(parsed)) {
    builder.addDiagnostic(
      diagnostic(finalLine ? "partial-final-record" : "corrupt-non-final-record", recordNumber, "invalid envelope"),
    );
    if (finalLine) {
      builder.markPartial();
    }
    return undefined;
  }

  const rawType = parsed.type;
  const type = typeof rawType === "string"
    && rawType.length > 0
    && rawType.length <= 96
    && rawType === rawType.trim()
    ? rawType
    : undefined;
  const payload = isRecord(parsed.payload) ? parsed.payload : undefined;
  if (type === undefined || payload === undefined) {
    builder.addDiagnostic(
      diagnostic(finalLine ? "partial-final-record" : "corrupt-non-final-record", recordNumber, "invalid envelope"),
    );
    if (finalLine) {
      builder.markPartial();
    }
    return undefined;
  }

  const timestamp = normalizeTimestamp(parsed.timestamp);
  if (timestamp === undefined) {
    builder.addDiagnostic(diagnostic("invalid-timestamp", recordNumber));
  }

  return { recordNumber, timestamp, type, payload };
}

function recognizeRecord(
  record: TranscriptRecord,
  builder: SummaryBuilder,
  addRelevanceReason: (value: AgentRelevanceCoverageReason) => void,
): { recognized: boolean; unknownCount: number } {
  if (!KNOWN_OUTER_TYPES.has(record.type)) {
    addRelevanceReason("unsupported-relevance-record");
    return {
      recognized: false,
      unknownCount: addUnknownDiagnostic(builder, record.recordNumber, "unknown outer record"),
    };
  }

  if (record.type === "event_msg") {
    const payloadType = typeof record.payload.type === "string"
      ? record.payload.type
      : undefined;
    if (payloadType === undefined || !KNOWN_EVENT_TYPES.has(payloadType)) {
      addRelevanceReason("unsupported-relevance-record");
      return {
        recognized: false,
        unknownCount: addUnknownDiagnostic(builder, record.recordNumber, "unknown event record"),
      };
    }
  }

  if (record.type === "response_item") {
    const payloadType = safeToken(record.payload.type);
    if (payloadType === undefined || !KNOWN_RESPONSE_TYPES.has(payloadType)) {
      addRelevanceReason("unsupported-relevance-record");
      return {
        recognized: false,
        unknownCount: addUnknownDiagnostic(builder, record.recordNumber, "unknown response record"),
      };
    }
  }

  return { recognized: true, unknownCount: 0 };
}

export async function parseTranscript(
  ref: AgentSessionRef,
  options: ParseTranscriptOptions = {},
): Promise<ParsedTranscript> {
  const builder = new SummaryBuilder(ref);
  if (path.basename(ref.sourcePath) === "history.jsonl") {
    builder.addDiagnostic(diagnostic("unsupported-source", undefined, "prompt index is not a transcript"));
    builder.markPartial();
    const summary = builder.snapshot();
    return {
      summary,
      diagnostics: summary.diagnostics,
      unknownRecordCount: 0,
      recordsSeen: 0,
      bytesRead: 0,
      sourceSignature: null,
      relevanceReasons: ["unreadable-transcript"],
    };
  }
  const before = await readFileSignature(ref.sourcePath);
  if (before === undefined) {
    builder.addDiagnostic(diagnostic("unreadable-transcript", undefined, "transcript unavailable"));
    builder.markPartial();
    const summary = builder.snapshot();
    return {
      summary,
      diagnostics: summary.diagnostics,
      unknownRecordCount: 0,
      recordsSeen: 0,
      bytesRead: 0,
      sourceSignature: null,
      relevanceReasons: ["unreadable-transcript"],
    };
  }

  const maxLineBytes = options.maxJsonlLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES;
  const summaryOnly = options.mode === "summary";
  const input = createReadStream(ref.sourcePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let pending: { readonly line: string; readonly recordNumber: number } | undefined;
  let physicalLineNumber = 0;
  let recordsSeen = 0;
  let unknownRecordCount = 0;
  let bytesRead = 0;
  const relevanceReasons = new Set<AgentRelevanceCoverageReason>();
  input.on("data", (chunk: string | Buffer) => {
    bytesRead += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
  });

  const consumeLine = async (
    item: { readonly line: string; readonly recordNumber: number },
    finalLine: boolean,
  ): Promise<void> => {
    const record = parseOuterRecord(item.line, item.recordNumber, finalLine, builder, maxLineBytes, summaryOnly);
    if (record === undefined) {
      return;
    }
    recordsSeen += 1;
    builder.observeTimestamp(record.timestamp);
    const recognition = recognizeRecord(record, builder, (reason) => relevanceReasons.add(reason));
    unknownRecordCount += recognition.unknownCount;
    if (!recognition.recognized) {
      return;
    }
    builder.observeRecord(record);
    if (options.onRecord !== undefined) {
      await options.onRecord(record, {
        session: builder.snapshot(),
        effectiveCwd: builder.currentEffectiveCwd(),
        addDiagnostic: (value) => builder.addDiagnostic(value),
        addRelevanceReason: (value) => relevanceReasons.add(value),
      });
    }
  };

  try {
    for await (const line of lines) {
      if (pending !== undefined) {
        await consumeLine(pending, false);
      }
      physicalLineNumber += 1;
      pending = { line, recordNumber: physicalLineNumber };
    }
    if (pending !== undefined) {
      await consumeLine(pending, true);
    }
  } catch (error: unknown) {
    builder.addDiagnostic(
      diagnostic("unreadable-transcript", undefined, isNodeError(error) ? "transcript read failed" : "transcript read failed"),
    );
    builder.markPartial();
  } finally {
    lines.close();
    input.destroy();
  }

  const after = await readFileSignature(ref.sourcePath);
  if (after === undefined) {
    builder.addDiagnostic(diagnostic("changed-during-read", undefined, "transcript disappeared during read"));
    builder.markPartial();
  } else if (signaturesDiffer(before, after)) {
    builder.addDiagnostic(diagnostic("changed-during-read", undefined, "transcript changed during read"));
    builder.markPartial();
  }

  if (builder.snapshot().sessionId === null) {
    builder.addDiagnostic(diagnostic("missing-session-metadata", undefined, "session metadata unavailable"));
  }

  for (const value of builder.snapshot().diagnostics) {
    switch (value.kind) {
      case "changed-during-read":
        relevanceReasons.add("changed-during-read");
        break;
      case "partial-final-record":
        relevanceReasons.add("partial-record");
        break;
      case "corrupt-non-final-record":
        relevanceReasons.add("corrupt-record");
        break;
      case "compacted-history":
      case "context-compaction":
        relevanceReasons.add("material-compaction");
        break;
      case "thread-rollback":
      case "turn-aborted":
        relevanceReasons.add("material-rollback-or-abort");
        break;
      case "retention-limit":
        relevanceReasons.add("retention-limit");
        break;
      case "unreadable-transcript":
        relevanceReasons.add("unreadable-transcript");
        break;
      default:
        break;
    }
  }

  const summary = builder.snapshot();
  const sourceSignature = before !== undefined && after !== undefined && !signaturesDiffer(before, after)
    ? before
    : null;
  return {
    summary,
    diagnostics: summary.diagnostics,
    unknownRecordCount,
    recordsSeen,
    bytesRead,
    sourceSignature,
    relevanceReasons: [...relevanceReasons],
  };
}

export async function readCodexSummary(ref: AgentSessionRef): Promise<AgentSessionSummary> {
  return (await parseTranscript(ref, { mode: "summary" })).summary;
}
