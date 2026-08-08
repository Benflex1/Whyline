import type {
  AgentEvidenceBundle,
  AgentHistoryDiscoveryContext,
  AgentHistorySource,
  AgentSessionRef,
  AgentSessionSummary,
  AgentEvidenceTarget,
} from "../agent-history-source.js";
import {
  discoverCodexSources,
  discoverCodexTranscripts,
  discoveryOptionsFromContext,
  type CodexDiscoveryOptions,
  type CodexDiscoveryResult,
} from "./discover.js";
import { extractCodexEvidence } from "./extract-evidence.js";
import { readCodexSummary } from "./parse-transcript.js";

export class CodexHistorySource implements AgentHistorySource {
  public readonly id = "codex";

  public constructor(private readonly options: CodexDiscoveryOptions = {}) {}

  public async *discover(
    context?: AgentHistoryDiscoveryContext,
  ): AsyncIterable<AgentSessionRef> {
    const contextOptions = discoveryOptionsFromContext(context);
    const options = contextOptions.codexHome === undefined
      ? this.options
      : { ...this.options, ...contextOptions };
    yield* discoverCodexTranscripts(options);
  }

  public discoverWithDiagnostics(
    context?: AgentHistoryDiscoveryContext,
  ): Promise<CodexDiscoveryResult> {
    const contextOptions = discoveryOptionsFromContext(context);
    const options = contextOptions.codexHome === undefined
      ? this.options
      : { ...this.options, ...contextOptions };
    return discoverCodexSources(options);
  }

  public readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary> {
    return readCodexSummary(ref);
  }

  public extractEvidence(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ): Promise<AgentEvidenceBundle> {
    return extractCodexEvidence(ref, target);
  }
}

export const codexHistorySource = new CodexHistorySource();
