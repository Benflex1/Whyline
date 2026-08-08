/**
 * Agent-neutral contracts used by the future correlation layer.
 *
 * The Codex adapter is responsible for translating its private transcript
 * records into these deliberately small, privacy-minimized types.
 */

export type AgentSourceKind = "active" | "archived" | (string & {});

export interface AgentSessionRef {
  readonly adapterId: string;
  /** Opaque read handle. The filename is not a session identity. */
  readonly sourcePath: string;
  readonly sourceKind: AgentSourceKind;
}

export interface AgentHistoryDiscoveryContext {
  /** Optional test/integration override for the adapter's history root. */
  readonly historyRoot?: string;
}

export interface CorrelationTarget {
  readonly repositoryPath?: string;
  readonly line?: number;
  readonly worktreeRoot?: string;
}

export interface AgentSessionSummary {
  readonly ref: AgentSessionRef;
  /** Null is reserved for an unusable source with a diagnostic. */
  readonly sessionId: string | null;
  readonly startedAt?: string | undefined;
  /** Timestamp of the last valid observed record, never a claimed end time. */
  readonly observedThroughAt?: string | undefined;
  readonly initialCwd?: string | undefined;
  readonly workingDirectories: readonly string[];
  readonly adapterSchema?: string | undefined;
  readonly surface?: string | undefined;
  readonly originator?: string | undefined;
  readonly source?: string | undefined;
  readonly clientVersion?: string | undefined;
  readonly model?: string | undefined;
  readonly parentSessionId?: string | undefined;
  readonly forkedFromSessionId?: string | undefined;
  readonly transcriptGit?: {
    readonly branch?: string | undefined;
    readonly commitHash?: string | undefined;
  } | undefined;
  readonly isPartial: boolean;
  readonly diagnostics: readonly AgentDiagnostic[];
}

export type EvidenceKind =
  | "command-attempt"
  | "stream-input"
  | "patch-attempt"
  | "patch-result"
  | "git-revision-reference"
  | "mcp-operation";

export type AgentOperation =
  | "command"
  | "terminal-input"
  | "patch"
  | "mcp";

export interface AgentPatchChange {
  readonly path: string;
  readonly changeType: "update" | "add" | "delete" | "unknown";
  readonly payloadKind: "unified-diff" | "content";
  readonly payloadRecovered: boolean;
  /** Non-reversible digest of the bounded recovered payload. */
  readonly payloadFingerprint: string;
  readonly payloadTruncated: boolean;
  /** Non-reversible per-line digests retained for future hunk comparison. */
  readonly addedLineFingerprints: readonly string[];
  readonly lineCount: number;
  readonly movedFrom?: string | undefined;
}

export interface AgentPatchEvidence {
  readonly callId: string;
  readonly reportedSuccess?: boolean | undefined;
  readonly status?: string | undefined;
  readonly changes: readonly AgentPatchChange[];
}

export interface AgentEvidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly occurredAt?: string | undefined;
  /** Normalized to the session's initial cwd when possible. */
  readonly cwd?: string | undefined;
  readonly paths: readonly string[];
  readonly operation?: AgentOperation | undefined;
  readonly callId?: string | undefined;
  /** True only when an exact transcript result was recorded for this call. */
  readonly resultRecorded?: boolean | undefined;
  /** Terminal session identifier from streamed input, not a fuzzy call link. */
  readonly terminalSessionId?: string | undefined;
  /** Present only for a patch result. */
  readonly reportedSuccess?: boolean | undefined;
  readonly status?: string | undefined;
  readonly patch?: AgentPatchEvidence | undefined;
  readonly commitIds: readonly string[];
  readonly extraction: "structured";
  readonly sourceRecord: number;
}

export type AgentDiagnosticKind =
  | "unknown-record"
  | "compacted-history"
  | "context-compaction"
  | "thread-rollback"
  | "turn-aborted"
  | "partial-final-record"
  | "corrupt-non-final-record"
  | "unreadable-transcript"
  | "changed-during-read"
  | "missing-session-metadata"
  | "conflicting-session-metadata"
  | "unlinked-tool-result"
  | "unsupported-source"
  | "invalid-timestamp"
  | "malformed-tool-arguments"
  | "retention-limit";

export interface AgentDiagnostic {
  readonly kind: AgentDiagnosticKind;
  readonly record?: number | undefined;
  /** Bounded, control-character-free detail; never raw transcript text. */
  readonly detail?: string | undefined;
}

export interface AgentEvidenceBundle {
  readonly session: AgentSessionSummary;
  readonly evidence: readonly AgentEvidence[];
  readonly unknownRecordCount: number;
  readonly diagnostics: readonly AgentDiagnostic[];
}

export interface AgentHistorySource {
  readonly id: string;
  discover(
    context?: AgentHistoryDiscoveryContext,
  ): AsyncIterable<AgentSessionRef>;
  readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary>;
  extractEvidence(
    ref: AgentSessionRef,
    target?: CorrelationTarget,
  ): Promise<AgentEvidenceBundle>;
}
