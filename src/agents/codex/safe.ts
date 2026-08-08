import { createHash } from "node:crypto";
import path from "node:path";

import type { AgentDiagnostic } from "../agent-history-source.js";

export const DEFAULT_MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_RETAINED_STRING_LENGTH = 512;
export const MAX_PATCH_PAYLOAD_BYTES = 256 * 1024;
export const MAX_PATCH_LINE_FINGERPRINTS = 128;

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getString(
  record: JsonRecord,
  key: string,
  maxLength = DEFAULT_MAX_RETAINED_STRING_LENGTH,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? sanitizeText(value, maxLength) : undefined;
}

export function getBoolean(
  record: JsonRecord,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getRecord(
  record: JsonRecord,
  key: string,
): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function sanitizeText(
  value: string,
  maxLength = DEFAULT_MAX_RETAINED_STRING_LENGTH,
): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength) : sanitized;
}

export function safeToken(value: unknown, maxLength = 128): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const sanitized = sanitizeText(value, maxLength).trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

export function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

export function safeCommitId(value: unknown): string | undefined {
  const token = safeToken(value, 128);
  return token !== undefined && /^[0-9a-fA-F]{7,128}$/.test(token)
    ? token
    : undefined;
}

export function safeAbsolutePath(value: unknown): string | undefined {
  const token = safeToken(value, 4096);
  if (token === undefined) {
    return undefined;
  }
  return token;
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeRelative(value: string): string {
  const slashValue = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashValue);
  if (normalized === ".") {
    return ".";
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    return "<outside-session-root>";
  }
  return normalized.replace(/^\.\//, "");
}

/**
 * Normalize an event path without retaining arbitrary absolute paths. Paths
 * under the session cwd become repository-like relative paths; other absolute
 * paths become a constant marker.
 */
export function normalizeEventPath(value: unknown, sessionCwd?: string): string | undefined {
  const token = safeToken(value, 4096);
  if (token === undefined) {
    return undefined;
  }

  if (!isAbsoluteLike(token)) {
    return normalizeRelative(token);
  }

  if (sessionCwd === undefined || !sessionCwd.startsWith("/")) {
    return "<outside-session-root>";
  }

  const base = path.resolve(sessionCwd);
  const resolved = path.resolve(token);
  const relative = path.relative(base, resolved);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    return normalizeRelative(relative === "" ? "." : relative);
  }
  return "<outside-session-root>";
}

export function normalizeEventCwd(value: unknown, sessionCwd?: string): string | undefined {
  return normalizeEventPath(value, sessionCwd);
}

export interface BoundedPayload {
  readonly text: string;
  readonly truncated: boolean;
}

export function boundPayload(value: string): BoundedPayload {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= MAX_PATCH_PAYLOAD_BYTES) {
    return { text: value, truncated: false };
  }

  return {
    text: Buffer.from(value, "utf8").subarray(0, MAX_PATCH_PAYLOAD_BYTES).toString("utf8"),
    truncated: true,
  };
}

export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const BOILERPLATE_LINES = new Set([
  "begin patch",
  "end patch",
  "no newline at end of file",
  "pass",
  "return;",
  "return null;",
  "return undefined;",
]);

export function isDistinctiveLine(value: string): boolean {
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

export function diagnostic(
  kind: AgentDiagnostic["kind"],
  record?: number,
  detail?: string,
): AgentDiagnostic {
  const result: { kind: AgentDiagnostic["kind"]; record?: number; detail?: string } = { kind };
  if (record !== undefined) {
    result.record = record;
  }
  const safeDetail = detail === undefined ? undefined : sanitizeText(detail, 160);
  if (safeDetail !== undefined && safeDetail.length > 0) {
    result.detail = safeDetail;
  }
  return result;
}

export function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}
