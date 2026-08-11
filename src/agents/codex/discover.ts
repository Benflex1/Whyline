import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentDiagnostic,
  AgentHistoryDiscoveryResult,
  AgentHistoryDiscoveryContext,
  AgentSessionRef,
} from "../agent-history-source.js";
import { diagnostic } from "./safe.js";

export interface CodexDiscoveryOptions {
  readonly codexHome?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export interface CodexDiscoveryResult extends AgentHistoryDiscoveryResult {
  readonly home: string;
}

async function namespaceSignature(
  home: string,
  refs: readonly AgentSessionRef[],
  availability: AgentHistoryDiscoveryResult["availability"],
): Promise<string> {
  const parts: string[] = [availability];
  for (const store of ["sessions", "archived_sessions"] as const) {
    const storePath = path.join(home, store);
    try {
      const metadata = await stat(storePath, { bigint: true });
      parts.push(`${store}:directory:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`);
      try {
        await access(storePath, constants.R_OK);
        parts.push(`${store}:readable`);
      } catch {
        parts.push(`${store}:unreadable`);
      }
    } catch (error: unknown) {
      parts.push(`${store}:${isMissing(error) ? "missing" : "unreadable"}`);
    }
  }
  for (const ref of refs) {
    try {
      const metadata = await stat(ref.sourcePath, { bigint: true });
      let readable = true;
      try {
        await access(ref.sourcePath, constants.R_OK);
      } catch {
        readable = false;
      }
      parts.push(`${ref.sourceKind}:${ref.sourcePath}:${readable ? "readable" : "unreadable"}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`);
    } catch (error: unknown) {
      parts.push(`${ref.sourceKind}:${ref.sourcePath}:${isMissing(error) ? "missing" : "unreadable"}`);
    }
  }
  return createHash("sha256").update(parts.sort().join("\0"), "utf8").digest("hex");
}

export function resolveCodexHome(options: CodexDiscoveryOptions = {}): string {
  const configuredHome = options.codexHome
    ?? (options.environment ?? process.env).CODEX_HOME;
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
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) {
      return false;
    }
    diagnostics.push(diagnostic("unreadable-transcript", undefined, `${sourceKind} store unavailable`));
    return true;
  }

  let limited = false;
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      limited = (await collectJsonlFiles(entryPath, sourceKind, refs, diagnostics)) || limited;
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
      limited = true;
      diagnostics.push(diagnostic("unreadable-transcript", undefined, `${sourceKind} transcript unavailable`));
    }
  }
  return limited;
}

export async function discoverCodexSources(
  options: CodexDiscoveryOptions = {},
): Promise<CodexDiscoveryResult> {
  const home = resolveCodexHome(options);
  const refs: AgentSessionRef[] = [];
  const diagnostics: AgentDiagnostic[] = [];

  try {
    await access(home, constants.R_OK);
    const metadata = await stat(home);
    if (!metadata.isDirectory()) {
      throw new Error("Codex home is not a directory");
    }
  } catch {
    diagnostics.push(diagnostic("unreadable-transcript", undefined, "Codex home unavailable"));
    return {
      home,
      availability: "unavailable",
      refs,
      diagnostics,
      namespaceSignature: await namespaceSignature(home, refs, "unavailable"),
    };
  }

  const activeLimited = await collectJsonlFiles(path.join(home, "sessions"), "active", refs, diagnostics);
  const archivedLimited = await collectJsonlFiles(path.join(home, "archived_sessions"), "archived", refs, diagnostics);
  refs.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  const availability = activeLimited || archivedLimited ? "limited" : "available";
  return {
    home,
    availability,
    refs,
    diagnostics,
    namespaceSignature: await namespaceSignature(home, refs, availability),
  };
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
