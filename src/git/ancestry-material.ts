import { TextDecoder } from "node:util";

import type { RepositoryContext } from "../provenance/model.js";
import { OperationalError } from "../whyline-error.js";
import { decodeGitUtf8, type GitResult, type GitRunner } from "./git-process.js";

const GIT_OBJECT_ID = /^[0-9a-fA-F]{7,128}$/;

export type AncestryMaterialFailure = "missing-history" | "unsupported-object" | "work-bound";

export interface AncestryBlobMaterial {
  readonly text: string;
  readonly lines: readonly string[];
  readonly complete: true;
}

export type AncestryBlobResult =
  | { readonly material: AncestryBlobMaterial }
  | { readonly failure: AncestryMaterialFailure }
  | { readonly absent: true };

interface TreeBlob {
  readonly objectId: string;
  readonly path: string;
}

async function runAncestryGit(
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
  operation: string,
): Promise<GitResult> {
  try {
    return await runner.run(args, { cwd });
  } catch (error: unknown) {
    if (error instanceof OperationalError) throw error;
    const detail = error instanceof Error ? error.message : "unknown process error";
    throw new OperationalError(operation + " could not start: " + detail);
  }
}

function failureForContext(context: RepositoryContext): "missing-history" | "unsupported-object" {
  return context.isShallow ? "missing-history" : "unsupported-object";
}

function parseTreeBlob(
  value: Buffer,
  expectedPath: string,
): TreeBlob | null | "malformed" {
  const records = decodeGitUtf8(value).split("\u0000").filter((record) => record.length > 0);
  if (records.length === 0) return null;
  if (records.length !== 1) return "malformed";
  const record = records[0] as string;
  const separator = record.indexOf("\t");
  if (separator < 0) return "malformed";
  const metadata = record.slice(0, separator).split(" ");
  const objectId = metadata[2];
  const type = metadata[1];
  const actualPath = record.slice(separator + 1);
  if (
    type !== "blob"
    || objectId === undefined
    || actualPath !== expectedPath
    || !GIT_OBJECT_ID.test(objectId)
  ) {
    return "malformed";
  }
  return { objectId, path: actualPath };
}

function parseBlob(value: Buffer): AncestryBlobMaterial | null {
  if (value.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return { text, lines, complete: true };
}

export async function loadAncestryBlob(
  runner: GitRunner,
  context: RepositoryContext,
  commitId: string,
  repositoryPath: string,
  options: { readonly maxBytes?: number } = {},
): Promise<AncestryBlobResult> {
  if (
    !GIT_OBJECT_ID.test(commitId)
    || repositoryPath.length === 0
    || repositoryPath.includes("\u0000")
  ) {
    return { failure: failureForContext(context) };
  }

  const treeResult = await runAncestryGit(
    runner,
    ["ls-tree", "-z", "--full-tree", commitId, "--", repositoryPath],
    context.worktreeRoot,
    "ancestry declaration tree lookup",
  );
  if (treeResult.exitCode !== 0) return { failure: failureForContext(context) };
  const treeBlob = parseTreeBlob(treeResult.stdout, repositoryPath);
  if (treeBlob === null) return { absent: true };
  if (treeBlob === "malformed") return { failure: "unsupported-object" };

  const blobResult = await runAncestryGit(
    runner,
    ["cat-file", "blob", treeBlob.objectId],
    context.worktreeRoot,
    "ancestry declaration blob lookup",
  );
  if (blobResult.exitCode !== 0) return { failure: failureForContext(context) };
  if (options.maxBytes !== undefined && blobResult.stdout.byteLength > options.maxBytes) {
    return { failure: "work-bound" };
  }
  const material = parseBlob(blobResult.stdout);
  return material === null
    ? { failure: "unsupported-object" }
    : { material };
}
