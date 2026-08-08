import type {
  AgentEvidence,
  AgentEvidenceBundle,
  AgentOperation,
  AgentPatchChange,
  AgentPatchHunkRange,
  AgentSessionRef,
  AgentEvidenceTarget,
} from "../agent-history-source.js";
import {
  boundPayload,
  digest,
  diagnostic,
  getBoolean,
  getRecord,
  isRecord,
  isDistinctiveLine,
  MAX_PATCH_LINE_FINGERPRINTS,
  normalizeEventCwd,
  normalizeEventPath,
  safeCommitId,
  safeToken,
  uniqueStrings,
  type JsonRecord,
} from "./safe.js";
import {
  parseTranscript,
  type ParsedTranscript,
  type TranscriptRecord,
  type TranscriptRecordContext,
} from "./parse-transcript.js";

const MAX_TRACKED_CALLS = 2048;
const MAX_PATCH_CHANGES = 256;

interface CallState {
  readonly callId: string;
  readonly operation: AgentOperation;
  readonly evidenceIndex?: number;
}

interface PatchAttempt {
  readonly paths: readonly string[];
}

function parseJsonArguments(
  value: unknown,
  context: TranscriptRecordContext,
  recordNumber: number,
): JsonRecord | undefined {
  if (typeof value !== "string") {
    context.addDiagnostic(diagnostic("malformed-tool-arguments", recordNumber));
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      context.addDiagnostic(diagnostic("malformed-tool-arguments", recordNumber));
      return undefined;
    }
    return parsed;
  } catch {
    context.addDiagnostic(diagnostic("malformed-tool-arguments", recordNumber));
    return undefined;
  }
}

function terminalSessionId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return safeToken(value, 128);
}

function patchInputPaths(
  input: unknown,
  sessionCwd: string | undefined,
): PatchAttempt {
  if (typeof input !== "string") {
    return { paths: [] };
  }

  const bounded = boundPayload(input);
  const paths: string[] = [];
  const marker = /^\*\*\* (Update|Add|Delete) File: (.+)$/;
  for (const line of bounded.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const match = marker.exec(line);
    if (match === null) {
      continue;
    }
    const pathValue = normalizeEventPath(match[2], sessionCwd);
    if (pathValue === undefined || paths.includes(pathValue)) {
      continue;
    }
    paths.push(pathValue);
  }

  return { paths };
}

interface NormalizedPayloadLines {
  readonly normalized: string;
  readonly matchLines: readonly string[];
  readonly lineCount: number;
  readonly hunkRanges: readonly AgentPatchHunkRange[];
}

function normalizedPayloadLines(
  payload: string,
  kind: "unified-diff" | "content",
  changeType: AgentPatchChange["changeType"],
): NormalizedPayloadLines {
  const normalized = payload.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  const matchLines = kind === "unified-diff"
    ? lines
      .filter((line) => changeType === "delete"
        ? line.startsWith("-") && !line.startsWith("---")
        : line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
    : lines;
  const hunkRanges = kind === "unified-diff" && changeType === "update"
    ? lines.flatMap((line) => {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match === null) {
        return [];
      }
      const oldStart = Number(match[1]);
      const oldLines = Number(match[2] ?? "1");
      const newStart = Number(match[3]);
      const newLines = Number(match[4] ?? "1");
      if (![oldStart, oldLines, newStart, newLines].every((value) => Number.isSafeInteger(value))) {
        return [];
      }
      return [{
        oldStart,
        oldLines,
        newStart,
        newLines,
      }];
    })
    : [];
  return { normalized, matchLines, lineCount: lines.length, hunkRanges };
}

function recoverPatchChange(
  rawPath: string,
  rawChange: unknown,
  sessionCwd: string | undefined,
): AgentPatchChange | undefined {
  const pathValue = normalizeEventPath(rawPath, sessionCwd);
  if (pathValue === undefined) {
    return undefined;
  }

  const change = isRecord(rawChange) ? rawChange : {};
  const rawType = safeToken(change.type);
  const changeType = rawType === "update" || rawType === "add" || rawType === "delete"
    ? rawType
    : "unknown";
  const rawDiff = typeof change.unified_diff === "string" ? change.unified_diff : undefined;
  const rawContent = typeof change.content === "string" ? change.content : undefined;
  const payloadKind = rawDiff !== undefined ? "unified-diff" : "content";
  const rawPayload = rawDiff ?? rawContent ?? "";
  const payloadRecovered = rawDiff !== undefined || rawContent !== undefined;
  const bounded = boundPayload(rawPayload);
  const lineData = normalizedPayloadLines(bounded.text, payloadKind, changeType);
  const supportsDirectMatch = (changeType === "update" && payloadKind === "unified-diff")
    || (changeType === "add" && payloadKind === "content")
    || (changeType === "delete" && payloadKind === "content");
  const matchSide = changeType === "update" && payloadKind === "unified-diff"
    ? "added"
    : changeType === "delete" && payloadKind === "content"
      ? "deleted"
      : "content";
  const matchLineFingerprints = (supportsDirectMatch ? lineData.matchLines : [])
    .slice(0, MAX_PATCH_LINE_FINGERPRINTS)
    .map((line) => digest(line));
  const distinctiveLineFingerprints = uniqueStrings(
    (supportsDirectMatch ? lineData.matchLines : [])
      .slice(0, MAX_PATCH_LINE_FINGERPRINTS)
      .filter(isDistinctiveLine)
      .map((line) => digest(line)),
  );
  const movedFromValue = normalizeEventPath(change.move_path, sessionCwd);

  const result: AgentPatchChange = {
    path: pathValue,
    changeType,
    payloadKind,
    payloadRecovered,
    payloadFingerprint: digest(lineData.normalized),
    payloadTruncated: bounded.truncated,
    addedLineFingerprints: changeType === "update" || changeType === "add"
      ? matchLineFingerprints
      : [],
    matchLineFingerprints,
    distinctiveLineFingerprints,
    matchSide,
    hunkRanges: supportsDirectMatch ? lineData.hunkRanges : [],
    lineCount: lineData.lineCount,
  };
  return movedFromValue === undefined ? result : { ...result, movedFrom: movedFromValue };
}

function recoverPatchChanges(
  changesValue: unknown,
  sessionCwd: string | undefined,
  context: TranscriptRecordContext,
  recordNumber: number,
): AgentPatchChange[] {
  if (!isRecord(changesValue)) {
    return [];
  }

  const changes: AgentPatchChange[] = [];
  for (const [rawPath, rawChange] of Object.entries(changesValue)) {
    if (changes.length >= MAX_PATCH_CHANGES) {
      context.addDiagnostic(diagnostic("retention-limit", recordNumber, "patch changes capped"));
      break;
    }
    const recovered = recoverPatchChange(rawPath, rawChange, sessionCwd);
    if (recovered !== undefined) {
      changes.push(recovered);
    }
  }
  return changes;
}

class EvidenceCollector {
  private readonly evidence: AgentEvidence[] = [];
  private readonly calls = new Map<string, CallState>();
  private nextEvidenceId = 1;

  public visit = async (
    record: TranscriptRecord,
    context: TranscriptRecordContext,
  ): Promise<void> => {
    switch (record.type) {
      case "session_meta":
        this.visitSessionMeta(record);
        break;
      case "response_item":
        this.visitResponseItem(record, context);
        break;
      case "event_msg":
        this.visitEventMessage(record, context);
        break;
      default:
        break;
    }
  };

  public getEvidence(): readonly AgentEvidence[] {
    return this.evidence;
  }

  private addEvidence(value: Omit<AgentEvidence, "id" | "extraction">): number {
    const evidence: AgentEvidence = {
      ...value,
      id: `evidence-${this.nextEvidenceId}`,
      extraction: "structured",
    };
    this.nextEvidenceId += 1;
    this.evidence.push(evidence);
    return this.evidence.length - 1;
  }

  private addCall(
    callId: string,
    operation: AgentOperation,
    evidenceIndex: number | undefined,
    context: TranscriptRecordContext,
    recordNumber: number,
  ): void {
    if (this.calls.has(callId)) {
      context.addDiagnostic(diagnostic("unsupported-source", recordNumber, "duplicate call identifier"));
      return;
    }
    if (this.calls.size >= MAX_TRACKED_CALLS) {
      context.addDiagnostic(diagnostic("retention-limit", recordNumber, "tool calls capped"));
      return;
    }
    const state: CallState = evidenceIndex === undefined
      ? { callId, operation }
      : { callId, operation, evidenceIndex };
    this.calls.set(callId, state);
  }

  private markCallResult(
    callIdValue: unknown,
    context: TranscriptRecordContext,
    recordNumber: number,
  ): void {
    const callId = safeToken(callIdValue, 256);
    if (callId === undefined) {
      context.addDiagnostic(diagnostic("unlinked-tool-result", recordNumber));
      return;
    }
    const call = this.calls.get(callId);
    if (call === undefined) {
      context.addDiagnostic(diagnostic("unlinked-tool-result", recordNumber));
      return;
    }
    if (call.evidenceIndex !== undefined) {
      const existing = this.evidence[call.evidenceIndex];
      if (existing !== undefined) {
        this.evidence[call.evidenceIndex] = { ...existing, resultRecorded: true };
      }
    }
  }

  private visitSessionMeta(record: TranscriptRecord): void {
    const git = getRecord(record.payload, "git");
    const commitHash = git === undefined ? undefined : safeCommitId(git.commit_hash);
    if (commitHash === undefined) {
      return;
    }

    this.addEvidence({
      kind: "git-revision-reference",
      occurredAt: record.timestamp,
      paths: [],
      commitReferenceKind: "session-head",
      commitIds: [commitHash],
      sourceRecord: record.recordNumber,
    });
  }

  private visitResponseItem(record: TranscriptRecord, context: TranscriptRecordContext): void {
    const payloadType = safeToken(record.payload.type);
    switch (payloadType) {
      case "function_call":
        this.visitFunctionCall(record, context);
        break;
      case "custom_tool_call":
        this.visitCustomToolCall(record, context);
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        this.markCallResult(record.payload.call_id, context, record.recordNumber);
        break;
      default:
        break;
    }
  }

  private visitFunctionCall(record: TranscriptRecord, context: TranscriptRecordContext): void {
    const callId = safeToken(record.payload.call_id, 256);
    const name = safeToken(record.payload.name, 128);
    if (callId === undefined || name === undefined) {
      context.addDiagnostic(diagnostic("unsupported-source", record.recordNumber, "tool call lacks identity"));
      return;
    }

    if (name === "exec_command") {
      const args = parseJsonArguments(record.payload.arguments, context, record.recordNumber);
      const workdir = args === undefined ? undefined : normalizeEventCwd(args.workdir, context.session.initialCwd);
      const evidenceIndex = this.addEvidence({
        kind: "command-attempt",
        occurredAt: record.timestamp,
        ...(workdir === undefined ? {} : { cwd: workdir }),
        paths: [],
        operation: "command",
        callId,
        resultRecorded: false,
        commitIds: [],
        sourceRecord: record.recordNumber,
      });
      this.addCall(callId, "command", evidenceIndex, context, record.recordNumber);
      return;
    }

    if (name === "write_stdin") {
      const args = parseJsonArguments(record.payload.arguments, context, record.recordNumber);
      const terminalId = args === undefined ? undefined : terminalSessionId(args.session_id);
      const evidenceIndex = this.addEvidence({
        kind: "stream-input",
        occurredAt: record.timestamp,
        paths: [],
        operation: "terminal-input",
        callId,
        resultRecorded: false,
        ...(terminalId === undefined ? {} : { terminalSessionId: terminalId }),
        commitIds: [],
        sourceRecord: record.recordNumber,
      });
      this.addCall(callId, "terminal-input", evidenceIndex, context, record.recordNumber);
    }
  }

  private visitCustomToolCall(record: TranscriptRecord, context: TranscriptRecordContext): void {
    const callId = safeToken(record.payload.call_id, 256);
    const name = safeToken(record.payload.name, 128);
    if (callId === undefined || name === undefined) {
      context.addDiagnostic(diagnostic("unsupported-source", record.recordNumber, "tool call lacks identity"));
      return;
    }

    if (name === "exec") {
      const evidenceIndex = this.addEvidence({
        kind: "command-attempt",
        occurredAt: record.timestamp,
        paths: [],
        operation: "command",
        callId,
        resultRecorded: false,
        commitIds: [],
        sourceRecord: record.recordNumber,
      });
      this.addCall(callId, "command", evidenceIndex, context, record.recordNumber);
      return;
    }

    if (name === "apply_patch") {
      const attempt = patchInputPaths(record.payload.input, context.session.initialCwd);
      const evidenceIndex = this.addEvidence({
        kind: "patch-attempt",
        occurredAt: record.timestamp,
        paths: attempt.paths,
        operation: "patch",
        callId,
        resultRecorded: false,
        commitIds: [],
        sourceRecord: record.recordNumber,
      });
      this.addCall(callId, "patch", evidenceIndex, context, record.recordNumber);
      return;
    }

    this.addCall(callId, "mcp", undefined, context, record.recordNumber);
  }

  private visitEventMessage(record: TranscriptRecord, context: TranscriptRecordContext): void {
    const payloadType = safeToken(record.payload.type);
    if (payloadType === "patch_apply_end") {
      this.visitPatchResult(record, context);
      return;
    }
    if (payloadType === "mcp_tool_call_end") {
      this.visitMcpResult(record, context);
    }
  }

  private visitPatchResult(record: TranscriptRecord, context: TranscriptRecordContext): void {
    const callId = safeToken(record.payload.call_id, 256);
    if (callId === undefined) {
      context.addDiagnostic(diagnostic("unlinked-tool-result", record.recordNumber));
      return;
    }

    const call = this.calls.get(callId);
    const linkedPatch = call?.operation === "patch";
    if (!linkedPatch) {
      context.addDiagnostic(diagnostic("unlinked-tool-result", record.recordNumber));
    } else {
      this.markCallResult(callId, context, record.recordNumber);
    }

    const changes = recoverPatchChanges(
      record.payload.changes,
      context.session.initialCwd,
      context,
      record.recordNumber,
    );
    const paths = uniqueStrings(changes.map((change) => change.path));
    const reportedSuccess = getBoolean(record.payload, "success");
    const status = safeToken(record.payload.status);
    const patch = {
      callId,
      ...(reportedSuccess === undefined ? {} : { reportedSuccess }),
      ...(status === undefined ? {} : { status }),
      changes,
    };
    this.addEvidence({
      kind: "patch-result",
      occurredAt: record.timestamp,
      paths,
      operation: "patch",
      callId,
      resultRecorded: linkedPatch,
      ...(reportedSuccess === undefined ? {} : { reportedSuccess }),
      ...(status === undefined ? {} : { status }),
      patch,
      commitIds: [],
      sourceRecord: record.recordNumber,
    });
  }

  private visitMcpResult(record: TranscriptRecord, context: TranscriptRecordContext): void {
    const callId = safeToken(record.payload.call_id, 256);
    if (callId === undefined) {
      context.addDiagnostic(diagnostic("unlinked-tool-result", record.recordNumber));
      return;
    }
    // The observed MCP shape is a self-contained completion event. If a
    // separate call record exists, exact-link it; otherwise retain only this
    // structured completion rather than inventing a fuzzy predecessor.
    if (this.calls.has(callId)) {
      this.markCallResult(callId, context, record.recordNumber);
    }
    this.addEvidence({
      kind: "mcp-operation",
      occurredAt: record.timestamp,
      paths: [],
      operation: "mcp",
      callId,
      resultRecorded: true,
      commitIds: [],
      sourceRecord: record.recordNumber,
    });
  }
}

export async function extractCodexEvidence(
  ref: AgentSessionRef,
  _target?: AgentEvidenceTarget,
): Promise<AgentEvidenceBundle> {
  const collector = new EvidenceCollector();
  const parsed: ParsedTranscript = await parseTranscript(ref, { onRecord: collector.visit });
  return {
    session: parsed.summary,
    evidence: collector.getEvidence(),
    unknownRecordCount: parsed.unknownRecordCount,
    diagnostics: parsed.diagnostics,
  };
}
