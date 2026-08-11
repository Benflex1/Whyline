import { stat } from "node:fs/promises";

import type {
  AgentEvidenceBundle,
  AgentHistoryDiscoveryContext,
  AgentHistorySource,
  AgentSummaryRelevanceScan,
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
import {
  extractCodexEvidence,
  scanCodexSummaryAndRelevance,
} from "./extract-evidence.js";
import { readCodexSummary } from "./parse-transcript.js";

function sourceSignatureKey(scan: AgentSummaryRelevanceScan): string | null {
  const signature = scan.sourceSignature;
  return signature === null
    ? null
    : `${signature.device}:${signature.inode}:${signature.size}:${signature.mtimeNs.toString()}`;
}

async function currentSourceSignatureKey(sourcePath: string): Promise<string | null> {
  try {
    const metadata = await stat(sourcePath, { bigint: true });
    return `${metadata.dev.toString()}:${metadata.ino.toString()}:${metadata.size.toString()}:${metadata.mtimeNs.toString()}`;
  } catch {
    return null;
  }
}

export class CodexHistorySource implements AgentHistorySource {
  public readonly id = "codex";
  private readonly scanCache = new Map<string, AgentSummaryRelevanceScan>();

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

  public async scanSummaryAndRelevance(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ): Promise<AgentSummaryRelevanceScan> {
    const currentKey = await currentSourceSignatureKey(ref.sourcePath);
    const cacheKey = currentKey === null ? null : `${this.id}:${currentKey}`;
    if (cacheKey !== null) {
      const cached = this.scanCache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    const scan = await scanCodexSummaryAndRelevance(ref, target);
    const stableKey = sourceSignatureKey(scan);
    if (stableKey !== null) {
      this.scanCache.set(`${this.id}:${stableKey}`, scan);
    }
    return scan;
  }

  public extractEvidence(
    ref: AgentSessionRef,
    target?: AgentEvidenceTarget,
  ): Promise<AgentEvidenceBundle> {
    return extractCodexEvidence(ref, target);
  }
}

export const codexHistorySource = new CodexHistorySource();
