import type { AgentCommitReferenceKind } from "../agents/agent-history-source.js";
import type { ResolvedCommitReference } from "../correlation/model.js";
import {
  decodeGitUtf8,
  type GitRunner,
} from "../git/git-process.js";
import type { RepositoryContext } from "./model.js";

const HEX_REFERENCE = /^[0-9a-fA-F]+$/;

function unresolved(
  kind: AgentCommitReferenceKind,
  reference: string,
  resolution: "ambiguous" | "unresolved" = "unresolved",
): ResolvedCommitReference {
  return { kind, reference, resolution };
}

function isFullObjectId(reference: string, targetCommitId: string): boolean {
  return reference.length === targetCommitId.length && HEX_REFERENCE.test(reference);
}

function parseResolvedObjectId(value: Buffer, expectedLength: number): string | null {
  const text = decodeGitUtf8(value).trim();
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length !== expectedLength) {
    return null;
  }
  return text.toLowerCase();
}

export async function resolveCommitReference(
  runner: GitRunner,
  repository: RepositoryContext,
  targetCommitId: string,
  kind: AgentCommitReferenceKind,
  reference: string,
): Promise<ResolvedCommitReference> {
  const normalizedReference = reference.toLowerCase();
  if (!HEX_REFERENCE.test(reference) || reference.length < 7) {
    return unresolved(kind, reference);
  }

  const normalizedTarget = targetCommitId.toLowerCase();
  if (isFullObjectId(reference, targetCommitId)) {
    return {
      kind,
      reference,
      resolution: normalizedReference === normalizedTarget ? "target" : "other",
    };
  }

  if (reference.length > targetCommitId.length) {
    return unresolved(kind, reference);
  }

  let result;
  try {
    result = await runner.run(
      ["rev-parse", "--verify", "--quiet", `${reference}^{commit}`],
      { cwd: repository.worktreeRoot },
    );
  } catch {
    return unresolved(kind, reference);
  }

  if (result.exitCode !== 0) {
    const diagnostic = decodeGitUtf8(result.stderr).toLowerCase();
    return unresolved(kind, reference, diagnostic.includes("ambiguous") ? "ambiguous" : "unresolved");
  }
  const resolved = parseResolvedObjectId(result.stdout, targetCommitId.length);
  if (resolved === null) {
    const diagnostic = decodeGitUtf8(result.stderr).toLowerCase();
    return unresolved(kind, reference, diagnostic.includes("ambiguous") ? "ambiguous" : "unresolved");
  }
  return {
    kind,
    reference,
    resolution: resolved === normalizedTarget ? "target" : "other",
  };
}
