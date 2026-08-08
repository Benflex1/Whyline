import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentDiagnostic,
  AgentHistoryDiscoveryContext,
  AgentSessionRef,
} from "../agent-history-source.js";
import { diagnostic } from "./safe.js";

export interface CodexDiscoveryOptions {
  readonly codexHome?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export interface CodexDiscoveryResult {
  readonly home: string;
  readonly refs: readonly AgentSessionRef[];
  readonly diagnostics: readonly AgentDiagnostic[];
}

export function resolveCodexHome(options: CodexDiscoveryOptions = {}): string {
  const configuredHome = options.codexHome ?? options.environment?.CODEX_HOME;
  const home = configuredHome !== undefined && configuredHome.length > 0
    ? configuredHome
    : path.join(options.homeDirectory ?? os.homedir(), ".codex");
  return path.resolve(home);
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function collectJsonlFiles(
  root: string,
  sourceKind: "active" | "archived",
  refs: AgentSessionRef[],
  diagnostics: AgentDiagnostic[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) {
      return;
    }
    diagnostics.push(diagnostic("unreadable-transcript", undefined, `${sourceKind} store unavailable`));
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(entryPath, sourceKind, refs, diagnostics);
      continue;
    }

    if (!entry.isFile() || entry.name === "history.jsonl" || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    try {
      await access(entryPath, constants.R_OK);
      const metadata = await stat(entryPath);
      if (!metadata.isFile()) {
        continue;
      }
      refs.push({ adapterId: "codex", sourcePath: entryPath, sourceKind });
    } catch {
      diagnostics.push(diagnostic("unreadable-transcript", undefined, `${sourceKind} transcript unavailable`));
    }
  }
}

export async function discoverCodexSources(
  options: CodexDiscoveryOptions = {},
): Promise<CodexDiscoveryResult> {
  const home = resolveCodexHome(options);
  const refs: AgentSessionRef[] = [];
  const diagnostics: AgentDiagnostic[] = [];

  await collectJsonlFiles(path.join(home, "sessions"), "active", refs, diagnostics);
  await collectJsonlFiles(path.join(home, "archived_sessions"), "archived", refs, diagnostics);
  refs.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  return { home, refs, diagnostics };
}

export async function* discoverCodexTranscripts(
  options: CodexDiscoveryOptions = {},
): AsyncGenerator<AgentSessionRef> {
  const result = await discoverCodexSources(options);
  for (const ref of result.refs) {
    yield ref;
  }
}

export function discoveryOptionsFromContext(
  context?: AgentHistoryDiscoveryContext,
): CodexDiscoveryOptions {
  return context?.historyRoot === undefined
    ? {}
    : { codexHome: context.historyRoot };
}
