import type {
  AgentCorrelationEvidenceProjection,
  AgentEvidence,
  AgentEvidenceBundle,
  AgentOperation,
  AgentPatchChange,
  AgentPatchEvidenceOrigin,
  AgentPatchHunkEvidence,
  AgentPatchHunkRange,
  AgentRelevanceCoverage,
  AgentSummaryRelevanceScan,
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

interface PatchOperationState {
  readonly evidenceIndex: number;
  durable?: {
    readonly callId: string;
    readonly turnId: string;
    readonly reportedSuccess: boolean;
    readonly status: string;
    readonly changes: readonly AgentPatchChange[];
  };
  conflicted: boolean;
}

interface RecoveredPatchChanges {
  readonly changes: readonly AgentPatchChange[];
  readonly complete: boolean;
}

interface DurableTerminalFacts {
  readonly callId?: string;
  readonly turnId?: string;
  readonly reportedSuccess?: boolean;
  readonly status?: string;
  readonly changes: readonly AgentPatchChange[];
  readonly changesComplete: boolean;
  readonly valid: boolean;
}

const MAX_DURABLE_ID_LENGTH = 256;

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
  if (typeof input !== "string" || sessionCwd === undefined) {
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
  readonly worktreeHunks: readonly AgentPatchHunkEvidence[];
  readonly worktreeComplete: boolean;
}

interface HunkBuilder {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly matchLines: string[];
  oldObserved: number;
  newObserved: number;
  truncated: boolean;
}

function hunkFingerprintData(
  lines: readonly string[],
  budget: { remaining: number },
  forcedTruncated = false,
): { readonly ordered: readonly string[]; readonly distinctive: readonly string[]; readonly truncated: boolean } {
  const ordered: string[] = [];
  let truncated = forcedTruncated;
  for (const line of lines) {
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    ordered.push(digest(line));
    budget.remaining -= 1;
  }
  if (ordered.length < lines.length) truncated = true;
  return {
    ordered,
    distinctive: uniqueStrings(
      lines.slice(0, ordered.length).filter(isDistinctiveLine).map((line) => digest(line)),
    ),
    truncated,
  };
}

function finishNormalizedHunk(
  builder: HunkBuilder,
  budget: { remaining: number },
  forcedTruncated: boolean,
): AgentPatchHunkEvidence {
  const fingerprints = hunkFingerprintData(builder.matchLines, budget, forcedTruncated || builder.truncated);
  const countMismatch = builder.oldObserved !== builder.oldLines || builder.newObserved !== builder.newLines;
  return {
    oldStart: builder.oldStart,
    oldLines: builder.oldLines,
    newStart: builder.newStart,
    newLines: builder.newLines,
    matchSide: "added",
    orderedLineFingerprints: fingerprints.ordered,
    distinctiveLineFingerprints: fingerprints.distinctive,
    lineCount: fingerprints.ordered.length,
    truncated: fingerprints.truncated || countMismatch,
  };
}

function parseNormalizedUpdateHunks(
  lines: readonly string[],
  payloadTruncated: boolean,
): { readonly hunks: readonly AgentPatchHunkEvidence[]; readonly ranges: readonly AgentPatchHunkRange[]; readonly complete: boolean } {
  const hunks: AgentPatchHunkEvidence[] = [];
  const ranges: AgentPatchHunkRange[] = [];
  const budget = { remaining: MAX_PATCH_LINE_FINGERPRINTS };
  let current: HunkBuilder | undefined;
  let complete = !payloadTruncated;
  const finish = (): void => {
    if (current === undefined) return;
    const normalized = finishNormalizedHunk(current, budget, payloadTruncated);
    hunks.push(normalized);
    if (normalized.truncated) complete = false;
    current = undefined;
  };

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match !== null) {
      finish();
      const oldStart = Number(match[1]);
      const oldLines = Number(match[2] ?? "1");
      const newStart = Number(match[3]);
      const newLines = Number(match[4] ?? "1");
      if (![oldStart, oldLines, newStart, newLines].every((value) => Number.isSafeInteger(value))) {
        complete = false;
        continue;
      }
      ranges.push({ oldStart, oldLines, newStart, newLines });
      current = { oldStart, oldLines, newStart, newLines, matchLines: [], oldObserved: 0, newObserved: 0, truncated: false };
      continue;
    }
    if (current === undefined) {
      if (line.length === 0 || line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("similarity ") || line.startsWith("\\")) continue;
      complete = false;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.newObserved += 1;
      current.matchLines.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.oldObserved += 1;
    } else if (line.startsWith(" ")) {
      current.oldObserved += 1;
      current.newObserved += 1;
    } else if (line.startsWith("\\")) {
      continue;
    } else if (line.length > 0) {
      current.truncated = true;
      complete = false;
    }
  }
  finish();
  if (hunks.length === 0) complete = false;
  return { hunks, ranges, complete };
}

function syntheticContentHunk(
  lines: readonly string[],
  payloadTruncated: boolean,
  budget: { remaining: number },
): AgentPatchHunkEvidence {
  const fingerprints = hunkFingerprintData(lines, budget, payloadTruncated);
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    matchSide: "content",
    orderedLineFingerprints: fingerprints.ordered,
    distinctiveLineFingerprints: fingerprints.distinctive,
    lineCount: fingerprints.ordered.length,
    truncated: fingerprints.truncated,
  };
}

function normalizedPayloadLines(
  payload: string,
  kind: "unified-diff" | "content",
  changeType: AgentPatchChange["changeType"],
  payloadTruncated: boolean,
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
  const parseLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  if (kind === "unified-diff" && changeType === "update") {
    const parsed = parseNormalizedUpdateHunks(parseLines, payloadTruncated);
    return { normalized, matchLines, lineCount: lines.length, hunkRanges: parsed.ranges, worktreeHunks: parsed.hunks, worktreeComplete: parsed.complete };
  }
  if (kind === "content" && (changeType === "add" || changeType === "delete")) {
    const hunk = syntheticContentHunk(parseLines, payloadTruncated, { remaining: MAX_PATCH_LINE_FINGERPRINTS });
    return { normalized, matchLines, lineCount: lines.length, hunkRanges: [], worktreeHunks: [hunk], worktreeComplete: !hunk.truncated };
  }
  return { normalized, matchLines, lineCount: lines.length, hunkRanges: [], worktreeHunks: [], worktreeComplete: false };
}

interface RecoveredSinglePatchChange {
  readonly change: AgentPatchChange;
  readonly worktreeComplete: boolean;
}

function recoverPatchChange(
  rawPath: string,
  rawChange: unknown,
  sessionCwd: string | undefined,
): RecoveredSinglePatchChange | undefined {
  if (sessionCwd === undefined) {
    return undefined;
  }
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
  const lineData = normalizedPayloadLines(bounded.text, payloadKind, changeType, bounded.truncated);
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
    worktreeHunks: lineData.worktreeHunks,
  };
  const normalized = movedFromValue === undefined ? result : { ...result, movedFrom: movedFromValue };
  return { change: normalized, worktreeComplete: lineData.worktreeComplete };
}

function safeNormalizedPatchPath(value: string | undefined): boolean {
  return value !== undefined
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.startsWith("<")
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.startsWith("../")
    && !value.includes("/../");
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function exactDurableIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > MAX_DURABLE_ID_LENGTH
    || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function durableChangeShapeIsValid(
  rawPath: string,
  rawChange: unknown,
  sessionCwd: string | undefined,
): boolean {
  if (sessionCwd === undefined) return false;
  const normalizedPath = normalizeEventPath(rawPath, sessionCwd);
  if (!safeNormalizedPatchPath(normalizedPath) || !isRecord(rawChange)) return false;

  const rawType = rawChange.type;
  if (rawType !== "add" && rawType !== "delete" && rawType !== "update") return false;
  const hasContent = hasOwn(rawChange, "content");
  const hasDiff = hasOwn(rawChange, "unified_diff");
  if (rawType === "add" || rawType === "delete") {
    if (!hasContent || hasDiff || typeof rawChange.content !== "string") return false;
    if (hasOwn(rawChange, "move_path")) return false;
    return true;
  }

  if (!hasDiff || hasContent || typeof rawChange.unified_diff !== "string") return false;
  if (!hasOwn(rawChange, "move_path") || rawChange.move_path === null) return true;
  if (typeof rawChange.move_path !== "string") return false;
  const movedFrom = normalizeEventPath(rawChange.move_path, sessionCwd);
  return safeNormalizedPatchPath(movedFrom);
}

function recoverPatchChanges(
  changesValue: unknown,
  sessionCwd: string | undefined,
  context: TranscriptRecordContext,
  recordNumber: number,
  strict = false,
): RecoveredPatchChanges {
  if (!isRecord(changesValue)) {
    context.addRelevanceReason("unclassified-patch-change");
    return { changes: [], complete: false };
  }

  const changes: AgentPatchChange[] = [];
  let complete = true;
  for (const [rawPath, rawChange] of Object.entries(changesValue)) {
    if (changes.length >= MAX_PATCH_CHANGES) {
      context.addDiagnostic(diagnostic("retention-limit", recordNumber, "patch changes capped"));
      complete = false;
      break;
    }
    if (strict && !durableChangeShapeIsValid(rawPath, rawChange, sessionCwd)) {
      complete = false;
      context.addRelevanceReason("unclassified-patch-change");
    }
    const recovered = recoverPatchChange(rawPath, rawChange, sessionCwd);
    if (recovered !== undefined) {
      changes.push(recovered.change);
      if (recovered.change.changeType === "unknown"
        || !recovered.change.payloadRecovered
        || recovered.change.payloadTruncated
        || !recovered.worktreeComplete) {
        context.addRelevanceReason("unclassified-patch-change");
        complete = false;
      }
    } else {
      context.addRelevanceReason("unclassified-patch-change");
      complete = false;
    }
  }
  return { changes, complete };
}

function inspectDurableTerminal(
  record: TranscriptRecord,
  context: TranscriptRecordContext,
): DurableTerminalFacts {
  const callId = exactDurableIdentifier(record.payload.call_id);
  const turnId = exactDurableIdentifier(record.payload.turn_id);
  const reportedSuccess = getBoolean(record.payload, "success");
  const statusValue = record.payload.status;
  const status = statusValue === "completed"
    || statusValue === "failed"
    || statusValue === "declined"
    ? statusValue
    : undefined;
  if (context.effectiveCwd === undefined) {
    context.addRelevanceReason("missing-effective-cwd");
  }

  const recovered = recoverPatchChanges(
    record.payload.changes,
    context.effectiveCwd,
    context,
    record.recordNumber,
    true,
  );
  const coherentStatus = (reportedSuccess === true && statusValue === "completed")
    || (reportedSuccess === false && (statusValue === "failed" || statusValue === "declined"));
  const valid = callId !== undefined
    && turnId !== undefined
    && coherentStatus
    && context.effectiveCwd !== undefined
    && recovered.complete;
  if (!valid) {
    context.addRelevanceReason("invalid-durable-patch-terminal");
  }
  return {
    ...(callId === undefined ? {} : { callId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(reportedSuccess === undefined ? {} : { reportedSuccess }),
    ...(status === undefined ? {} : { status }),
    changes: recovered.changes,
    changesComplete: recovered.complete,
    valid,
  };
}

function patchFactsEqual(
  left: {
    readonly reportedSuccess?: boolean | undefined;
    readonly status?: string | undefined;
    readonly changes: readonly AgentPatchChange[];
  },
  right: {
    readonly reportedSuccess?: boolean | undefined;
    readonly status?: string | undefined;
    readonly changes: readonly AgentPatchChange[];
  },
): boolean {
  return left.reportedSuccess === right.reportedSuccess
    && left.status === right.status
    && JSON.stringify(left.changes) === JSON.stringify(right.changes);
}

class EvidenceCollector {
  private readonly evidence: AgentEvidence[] = [];
  private readonly calls = new Map<string, CallState>();
  private readonly patchOperations = new Map<string, PatchOperationState>();
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
    if (operation === "patch") {
      const patchOperation = this.patchOperations.get(callId);
      if (patchOperation !== undefined) {
        this.addPatchOrigin(patchOperation.evidenceIndex, "linked-request-result");
      }
    }
  }

  private addPatchOrigin(
    evidenceIndex: number,
    origin: AgentPatchEvidenceOrigin,
  ): void {
    const existing = this.evidence[evidenceIndex];
    if (existing?.kind !== "patch-result" || existing.patch === undefined) return;
    const origins = existing.patch.evidenceOrigins ?? [];
    if (origins.includes(origin)) return;
    const hasLinked = origins.includes("linked-request-result") || origin === "linked-request-result";
    const hasDurable = origins.includes("self-contained-durable-terminal") || origin === "self-contained-durable-terminal";
    const nextOrigins: AgentPatchEvidenceOrigin[] = [
      ...(hasLinked ? ["linked-request-result" as const] : []),
      ...(hasDurable ? ["self-contained-durable-terminal" as const] : []),
    ];
    this.evidence[evidenceIndex] = {
      ...existing,
      patch: { ...existing.patch, evidenceOrigins: nextOrigins },
    };
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
      const workdir = args === undefined
        ? undefined
        : normalizeEventCwd(args.workdir, context.effectiveCwd);
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
      return;
    }

    context.addRelevanceReason("unsupported-relevance-record");
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
      if (context.effectiveCwd === undefined) {
        context.addRelevanceReason("missing-effective-cwd");
      }
      const attempt = patchInputPaths(record.payload.input, context.effectiveCwd);
      const evidenceIndex = this.addEvidence({
        kind: "patch-attempt",
        occurredAt: record.timestamp,
        ...(context.effectiveCwd === undefined ? {} : { cwd: context.effectiveCwd }),
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

    context.addRelevanceReason("unsupported-relevance-record");
    this.addCall(callId, "mcp", undefined, context, record.recordNumber);
  }

  private addOrMergePatchResult(
    record: TranscriptRecord,
    context: TranscriptRecordContext,
    value: {
      readonly callId: string;
      readonly cwd?: string;
      readonly paths: readonly string[];
      readonly resultRecorded: boolean;
      readonly reportedSuccess?: boolean;
      readonly status?: string;
      readonly changes: readonly AgentPatchChange[];
      readonly origins?: readonly AgentPatchEvidenceOrigin[];
      readonly durable?: {
        readonly turnId: string;
        readonly reportedSuccess: boolean;
        readonly status: string;
      };
    },
  ): void {
    const patch = {
      callId: value.callId,
      ...(value.origins === undefined ? {} : { evidenceOrigins: value.origins }),
      ...(value.reportedSuccess === undefined ? {} : { reportedSuccess: value.reportedSuccess }),
      ...(value.status === undefined ? {} : { status: value.status }),
      changes: value.changes,
    };
    const existingState = this.patchOperations.get(value.callId);
    if (existingState === undefined) {
      const evidenceIndex = this.addEvidence({
        kind: "patch-result",
        occurredAt: record.timestamp,
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        paths: value.paths,
        operation: "patch",
        callId: value.callId,
        resultRecorded: value.resultRecorded,
        ...(value.reportedSuccess === undefined ? {} : { reportedSuccess: value.reportedSuccess }),
        ...(value.status === undefined ? {} : { status: value.status }),
        patch,
        commitIds: [],
        sourceRecord: record.recordNumber,
      });
      this.patchOperations.set(value.callId, {
        evidenceIndex,
        ...(value.durable === undefined ? {} : {
          durable: {
            callId: value.callId,
            turnId: value.durable.turnId,
            reportedSuccess: value.durable.reportedSuccess,
            status: value.durable.status,
            changes: value.changes,
          },
        }),
        conflicted: false,
      });
      return;
    }

    const existing = this.evidence[existingState.evidenceIndex];
    if (existing?.kind !== "patch-result" || existing.patch === undefined) return;
    let incompatible = existingState.conflicted;
    if (value.durable !== undefined) {
      if (existingState.durable !== undefined) {
        incompatible = incompatible
          || existingState.durable.turnId !== value.durable.turnId
          || existingState.durable.reportedSuccess !== value.durable.reportedSuccess
          || existingState.durable.status !== value.durable.status
          || JSON.stringify(existingState.durable.changes) !== JSON.stringify(value.changes);
      } else if (existing.patch.evidenceOrigins === undefined
        || !patchFactsEqual(existing.patch, patch)) {
        incompatible = true;
      }
    }

    if (incompatible) {
      context.addRelevanceReason("invalid-durable-patch-terminal");
      existingState.conflicted = true;
      const { reportedSuccess: _reportedSuccess, status: _status, ...withoutResultFacts } = existing;
      const { reportedSuccess: _patchReportedSuccess, status: _patchStatus, ...withoutPatchFacts } = existing.patch;
      this.evidence[existingState.evidenceIndex] = {
        ...withoutResultFacts,
        resultRecorded: false,
        patch: {
          ...withoutPatchFacts,
          ...(value.origins === undefined ? {} : { evidenceOrigins: value.origins }),
        },
      };
      return;
    }

    if (value.durable !== undefined) {
      existingState.durable = {
        callId: value.callId,
        turnId: value.durable.turnId,
        reportedSuccess: value.durable.reportedSuccess,
        status: value.durable.status,
        changes: value.changes,
      };
      this.evidence[existingState.evidenceIndex] = {
        ...existing,
        occurredAt: record.timestamp,
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        paths: value.paths,
        resultRecorded: value.resultRecorded,
        ...(value.reportedSuccess === undefined ? {} : { reportedSuccess: value.reportedSuccess }),
        ...(value.status === undefined ? {} : { status: value.status }),
        patch,
        sourceRecord: record.recordNumber,
      };
      return;
    }

    if (value.origins !== undefined) {
      this.addPatchOrigin(existingState.evidenceIndex, value.origins[0]!);
    }
  }

  private visitEventMessage(record: TranscriptRecord, context: TranscriptRecordContext): void {
    const payloadType = safeToken(record.payload.type);
    if (record.payload.type === "patch_apply_end") {
      this.visitPatchResult(record, context);
      return;
    }
    if (payloadType === "mcp_tool_call_end") {
      context.addRelevanceReason("unsupported-relevance-record");
      this.visitMcpResult(record, context);
    }
  }

  private visitPatchResult(record: TranscriptRecord, context: TranscriptRecordContext): void {
    const callId = safeToken(record.payload.call_id, 256);
    const exactCallId = exactDurableIdentifier(record.payload.call_id);
    const lookupCallId = exactCallId ?? callId;
    const call = lookupCallId === undefined ? undefined : this.calls.get(lookupCallId);
    const linkedPatch = call?.operation === "patch";

    // A persisted apply_patch request keeps the historical linked contract. If
    // it also satisfies the closed durable-terminal contract, the one result
    // carries both origins and the durable terminal facts are authoritative.
    const hasDurableIdentity = exactCallId !== undefined
      && exactDurableIdentifier(record.payload.turn_id) !== undefined;
    const durable = hasDurableIdentity || !linkedPatch
      ? inspectDurableTerminal(record, context)
      : undefined;

    if (linkedPatch && callId !== undefined) {
      this.markCallResult(callId, context, record.recordNumber);
      const loose = recoverPatchChanges(
        record.payload.changes,
        context.effectiveCwd,
        context,
        record.recordNumber,
      );
      const reportedSuccess = getBoolean(record.payload, "success");
      if (reportedSuccess === undefined) {
        context.addRelevanceReason("unclassified-patch-change");
      }
      const status = safeToken(record.payload.status);
      const useDurable = durable?.valid === true
        && durable.callId === callId
        && durable.reportedSuccess !== undefined
        && durable.status !== undefined;
      const normalizedChanges = useDurable ? durable.changes : loose.changes;
      const normalizedSuccess = useDurable ? durable.reportedSuccess : reportedSuccess;
      const normalizedStatus = useDurable ? durable.status : status;
      const origins: AgentPatchEvidenceOrigin[] = useDurable
        ? ["linked-request-result", "self-contained-durable-terminal"]
        : ["linked-request-result"];
      this.addOrMergePatchResult(record, context, {
        callId,
        ...(context.effectiveCwd === undefined ? {} : { cwd: context.effectiveCwd }),
        paths: uniqueStrings(normalizedChanges.map((change) => change.path)),
        resultRecorded: true,
        ...(normalizedSuccess === undefined ? {} : { reportedSuccess: normalizedSuccess }),
        ...(normalizedStatus === undefined ? {} : { status: normalizedStatus }),
        changes: normalizedChanges,
        origins,
        ...(useDurable ? {
          durable: {
            turnId: durable.turnId!,
            reportedSuccess: durable.reportedSuccess!,
            status: durable.status!,
          },
        } : {}),
      });
      return;
    }

    // The custom exec record is intentionally ignored as provenance. The
    // terminal is either a valid self-contained operation or a limited,
    // non-linked audit fact; neither case invents a request/result pair.
    if (durable === undefined || durable.callId === undefined) {
      context.addRelevanceReason("invalid-durable-patch-terminal");
      return;
    }
    const paths = uniqueStrings(durable.changes.map((change) => change.path));
    this.addOrMergePatchResult(record, context, {
      callId: durable.callId,
      ...(context.effectiveCwd === undefined ? {} : { cwd: context.effectiveCwd }),
      paths,
      resultRecorded: durable.valid,
      ...(durable.reportedSuccess === undefined ? {} : { reportedSuccess: durable.reportedSuccess }),
      ...(durable.status === undefined ? {} : { status: durable.status }),
      changes: durable.changes,
      ...(durable.valid ? { origins: ["self-contained-durable-terminal"] as const } : {}),
      ...(durable.valid && durable.turnId !== undefined && durable.reportedSuccess !== undefined && durable.status !== undefined
        ? {
          durable: {
            turnId: durable.turnId,
            reportedSuccess: durable.reportedSuccess,
            status: durable.status,
          },
        }
        : {}),
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

export async function scanCodexSummaryAndRelevance(
  ref: AgentSessionRef,
  _target?: AgentEvidenceTarget,
): Promise<AgentSummaryRelevanceScan> {
  const collector = new EvidenceCollector();
  const parsed: ParsedTranscript = await parseTranscript(ref, { onRecord: collector.visit });
  const evidence = collector.getEvidence().filter((value) =>
    value.kind === "patch-attempt"
      || value.kind === "patch-result"
      || value.kind === "git-revision-reference");
  const correlationEvidence: AgentCorrelationEvidenceProjection = {
    evidence,
    unknownRecordCount: parsed.unknownRecordCount,
  };
  const relevanceCoverage: AgentRelevanceCoverage = {
    status: parsed.relevanceReasons.length === 0 ? "complete" : "limited",
    reasons: parsed.relevanceReasons,
  };
  return {
    ref,
    summary: parsed.summary,
    correlationEvidence,
    relevanceCoverage,
    bytesRead: parsed.bytesRead,
    recordsSeen: parsed.recordsSeen,
    sourceSignature: parsed.sourceSignature,
  };
}
