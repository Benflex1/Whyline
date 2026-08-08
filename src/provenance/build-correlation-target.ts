import { createHash } from "node:crypto";

import type {
  CorrelationHunk,
  CorrelationTarget,
} from "../correlation/model.js";
import type {
  GitDiffLine,
  GitHunk,
  GitProvenance,
  RepositoryContext,
  ResolvedCodeLocation,
} from "./model.js";

const MAX_HUNK_FINGERPRINTS = 128;
const BOILERPLATE_LINES = new Set([
  "begin patch",
  "end patch",
  "no newline at end of file",
  "pass",
  "return;",
  "return null;",
  "return undefined;",
]);

function digestLine(value: string): string {
  return createHash("sha256")
    .update(value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), "utf8")
    .digest("hex");
}

function isDistinctiveLine(value: string): boolean {
  const line = value.trim();
  if (
    line.length < 4
    || /^[\p{P}\p{S}\s]+$/u.test(line)
    || /^[A-Za-z_$][\w$]*$/.test(line)
  ) {
    return false;
  }

  return !BOILERPLATE_LINES.has(line.toLowerCase())
    && !/^(?:return|throw|yield)\s+[A-Za-z_$][\w$]*;?$/.test(line);
}

function sideFingerprints(
  lines: readonly GitDiffLine[],
  kind: "added" | "deleted",
): {
  readonly all: readonly string[];
  readonly distinctive: readonly string[];
  readonly truncated: boolean;
} {
  const matching = lines.filter((line) => line.kind === kind);
  const selected = matching.slice(0, MAX_HUNK_FINGERPRINTS);
  const all = selected.map((line) => digestLine(line.text));
  const distinctive = selected
    .filter((line) => isDistinctiveLine(line.text))
    .map((line) => digestLine(line.text));
  return {
    all,
    distinctive: [...new Set(distinctive)],
    truncated: selected.length < matching.length,
  };
}

function correlationHunk(hunk: GitHunk): CorrelationHunk {
  const added = sideFingerprints(hunk.lines, "added");
  const deleted = sideFingerprints(hunk.lines, "deleted");
  return {
    oldPath: hunk.oldPath,
    newPath: hunk.newPath,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    targetLineKind: hunk.targetLineKind,
    addedLineFingerprints: added.all,
    deletedLineFingerprints: deleted.all,
    distinctiveAddedLineFingerprints: added.distinctive,
    distinctiveDeletedLineFingerprints: deleted.distinctive,
    truncated: hunk.truncated || added.truncated || deleted.truncated,
  };
}

function selectedParentId(provenance: GitProvenance): string | null {
  return provenance.parent?.kind === "commit"
    ? provenance.parent.commitId
    : null;
}

export function buildCorrelationTarget(
  repository: RepositoryContext,
  location: ResolvedCodeLocation,
  provenance: GitProvenance,
): CorrelationTarget | null {
  if (
    provenance.state !== "committed"
    || provenance.commit === null
  ) {
    return null;
  }

  return {
    repository: {
      worktreeRoot: repository.worktreeRoot,
      commonGitDir: repository.commonGitDir,
      objectFormat: repository.objectFormat,
      worktrees: repository.worktrees.map((worktree) => ({
        path: worktree.path,
        commonGitDir: repository.commonGitDir,
      })),
    },
    targetPath: location.repositoryPath,
    blamedPath: provenance.blame?.filename ?? null,
    commit: {
      id: provenance.commit.id,
      authoredAt: provenance.commit.authoredAt,
      committedAt: provenance.commit.committedAt,
    },
    selectedParentId: selectedParentId(provenance),
    changedPaths: provenance.changedPaths.map((change) => ({
      oldPath: change.oldPath,
      newPath: change.newPath,
    })),
    relevantHunks: provenance.relevantHunks.map(correlationHunk),
  };
}
