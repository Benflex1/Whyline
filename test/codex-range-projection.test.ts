import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentEvidence,
  AgentEvidenceBundle,
  AgentHistoryDiscoveryContext,
  AgentHistoryDiscoveryResult,
  AgentHistorySource,
  AgentSessionRef,
  AgentSessionSummary,
  AgentSummaryRelevanceScan,
} from "../src/agents/agent-history-source.js";
import { GitProcess } from "../src/git/git-process.js";
import { discoverRepositoryContext } from "../src/git/repository-context.js";
import type {
  CorrelationHunk,
  CorrelationTarget,
} from "../src/correlation/model.js";
import {
  correlateCodex,
  prepareCodexEvidence,
  projectPreparedCodex,
} from "../src/provenance/correlate-codex.js";
import type { ResolvedCodeLocation } from "../src/provenance/model.js";

const WORKTREE = process.cwd();
const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PARENT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function session(ref: AgentSessionRef, id: string): AgentSessionSummary {
  return {
    ref,
    sessionId: id,
    startedAt: "2026-08-11T00:00:00.000Z",
    observedThroughAt: "2026-08-11T01:00:00.000Z",
    initialCwd: WORKTREE,
    workingDirectories: [WORKTREE],
    isPartial: false,
    diagnostics: [],
  };
}

function patchEvidence(
  ref: AgentSessionRef,
  sessionId: string,
  targetPath: string,
): AgentSummaryRelevanceScan {
  const change = {
    path: targetPath,
    changeType: "update" as const,
    payloadKind: "unified-diff" as const,
    payloadRecovered: true,
    payloadFingerprint: sessionId + "-payload",
    payloadTruncated: false,
    addedLineFingerprints: ["distinctive-line-a", "distinctive-line-b"],
    matchLineFingerprints: ["distinctive-line-a", "distinctive-line-b"],
    distinctiveLineFingerprints: ["distinctive-line-a", "distinctive-line-b"],
    matchSide: "added" as const,
    hunkRanges: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
    lineCount: 2,
  };
  const evidence: AgentEvidence = {
    id: sessionId + "-evidence",
    kind: "patch-result",
    occurredAt: "2026-08-11T00:30:00.000Z",
    cwd: WORKTREE,
    paths: [targetPath],
    operation: "patch",
    callId: sessionId + "-call",
    resultRecorded: true,
    reportedSuccess: true,
    patch: {
      callId: sessionId + "-call",
      reportedSuccess: true,
      changes: [change],
    },
    commitIds: [],
    extraction: "structured",
    sourceRecord: 10,
  };
  return {
    ref,
    summary: session(ref, sessionId),
    correlationEvidence: { evidence: [evidence], unknownRecordCount: 0 },
    relevanceCoverage: { status: "complete", reasons: [] },
    bytesRead: 128,
    recordsSeen: 12,
    sourceSignature: null,
  };
}

class CountingSource implements AgentHistorySource {
  public readonly id = "synthetic";
  public discoverCalls = 0;
  public scanCalls = 0;
  public readonly refs: readonly AgentSessionRef[] = [
    { adapterId: "synthetic", sourcePath: "session-a", sourceKind: "active" },
    { adapterId: "synthetic", sourcePath: "session-b", sourceKind: "active" },
  ];

  public async *discover(_context?: AgentHistoryDiscoveryContext): AsyncIterable<AgentSessionRef> {
    for (const ref of this.refs) yield ref;
  }

  public discoverWithDiagnostics(
    _context?: AgentHistoryDiscoveryContext,
  ): Promise<AgentHistoryDiscoveryResult> {
    this.discoverCalls += 1;
    return Promise.resolve({
      availability: "available",
      refs: this.refs,
      diagnostics: [],
      namespaceSignature: "stable",
    });
  }

  public scanSummaryAndRelevance(ref: AgentSessionRef): Promise<AgentSummaryRelevanceScan> {
    this.scanCalls += 1;
    const targetPath = ref.sourcePath === "session-a" ? "src/a.ts" : "src/b.ts";
    const id = ref.sourcePath === "session-a" ? "session-a" : "session-b";
    return Promise.resolve(patchEvidence(ref, id, targetPath));
  }

  public readSummary(ref: AgentSessionRef): Promise<AgentSessionSummary> {
    return Promise.resolve(session(ref, ref.sourcePath));
  }

  public extractEvidence(ref: AgentSessionRef): Promise<AgentEvidenceBundle> {
    const scan = patchEvidence(ref, ref.sourcePath, "src/a.ts");
    return Promise.resolve({
      session: scan.summary,
      evidence: scan.correlationEvidence.evidence,
      unknownRecordCount: 0,
      diagnostics: [],
    });
  }
}

function hunk(targetPath: string): CorrelationHunk {
  return {
    oldPath: targetPath,
    newPath: targetPath,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 2,
    targetLineKind: "added",
    addedLineFingerprints: ["distinctive-line-a", "distinctive-line-b"],
    deletedLineFingerprints: ["old-line-a"],
    distinctiveAddedLineFingerprints: ["distinctive-line-a", "distinctive-line-b"],
    distinctiveDeletedLineFingerprints: ["old-line-a"],
    truncated: false,
  };
}

function target(targetPath: string): CorrelationTarget {
  return {
    repository: {
      worktreeRoot: WORKTREE,
      commonGitDir: WORKTREE + "/.git",
      objectFormat: "sha1",
      worktrees: [{ path: WORKTREE, commonGitDir: WORKTREE + "/.git" }],
    },
    targetPath,
    blamedPath: targetPath,
    commit: {
      id: COMMIT,
      authoredAt: "2026-08-11T00:00:00.000Z",
      committedAt: "2026-08-11T00:00:00.000Z",
    },
    selectedParentId: PARENT,
    changedPaths: [{ oldPath: targetPath, newPath: targetPath }],
    relevantHunks: [hunk(targetPath)],
  };
}

function location(targetPath: string): ResolvedCodeLocation {
  return {
    input: targetPath + ":1",
    absolutePath: WORKTREE + "/" + targetPath,
    repositoryPath: targetPath,
    requestedLine: 1,
    lineContent: "distinctive",
    lineDigest: "digest",
    fileSnapshot: { size: 1, mtimeMs: 0, ino: 1, dev: 1, digest: "digest" },
    targetState: "clean",
    targetDirty: false,
  };
}

test("prepares Codex history once and projects different targets independently", async () => {
  const source = new CountingSource();
  const git = new GitProcess();
  const repository = await discoverRepositoryContext(git, WORKTREE);
  const prepared = await prepareCodexEvidence({
    repository,
    git,
    agentHistorySource: source,
  });

  const first = await projectPreparedCodex(prepared, target("src/a.ts"), location("src/a.ts"));
  const second = await projectPreparedCodex(prepared, target("src/b.ts"), location("src/b.ts"));

  assert.equal(source.discoverCalls, 2);
  assert.equal(source.scanCalls, 2);
  assert.equal(first.status, "matched");
  assert.equal(second.status, "matched");
  assert.notEqual(first.selected?.session.sessionId, second.selected?.session.sessionId);
});

test("projected correlation preserves the existing single-target decision", async () => {
  const source = new CountingSource();
  const git = new GitProcess();
  const repository = await discoverRepositoryContext(git, WORKTREE);
  const prepared = await prepareCodexEvidence({
    repository,
    git,
    agentHistorySource: source,
  });
  const projected = await projectPreparedCodex(
    prepared,
    target("src/a.ts"),
    location("src/a.ts"),
  );
  const existing = await correlateCodex({
    target: target("src/a.ts"),
    location: location("src/a.ts"),
    repository,
    git,
    agentHistorySource: source,
  });

  assert.deepEqual(projected, existing);
});
