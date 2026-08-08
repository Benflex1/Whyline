import { createHash } from "node:crypto";

import type {
  CorrelationCandidate,
  CorrelationLimitationKind,
  CorrelationResult,
  CorrelationSignalKind,
} from "../correlation/model.js";

const MIN_SESSION_ID_PREFIX = 8;
const MAX_RENDERED_CANDIDATES = 8;
const MAX_RENDERED_EXPLANATIONS = 4;
const MAX_RENDERED_SESSION_ID_LENGTH = 80;
const SESSION_ID_HASH_LENGTH = 16;
const MAX_SESSION_ID_HASH_LENGTH = 64;

const STATUS_TEXT: Record<CorrelationResult["status"], string> = {
  matched: "No reliable Codex session match found",
  ambiguous: "Multiple strong candidates; no session selected",
  none: "No reliable Codex session match found",
  unavailable: "Codex history unavailable",
};

const COVERAGE_TEXT: Record<CorrelationResult["coverage"]["status"], string> = {
  complete: "complete",
  limited: "limited",
  unavailable: "unavailable",
};

const SIGNAL_TEXT: Record<CorrelationSignalKind, string> = {
  "session-head-target-reference": "session HEAD context matches the attributed commit",
  "produced-target-commit-reference": "recorded commit reference matches the attributed commit",
  "historical-commit-reference": "session history references an earlier commit",
  "structured-patch-overlap": "structured patch content overlaps the attributed change",
  "exact-current-worktree": "session repository matches the current worktree",
  "linked-worktree-common-directory": "session repository matches a linked worktree",
  "structured-patch-target-path": "structured patch targets the attributed path",
  "changed-path-overlap": "structured patch path overlaps the attributed change",
  "structured-patch-attempt-target-path": "a structured patch attempt names the attributed path",
  "temporal-proximity": "session timing is near the attributed change",
  "structured-content-divergence": "structured patch content diverges from the attributed change",
};

const LIMITATION_TEXT: Record<CorrelationLimitationKind, string> = {
  "empty-readable-store": "Codex history is readable but contains no sessions",
  "discovery-unavailable": "Codex history could not be read",
  "discovery-limited": "Codex history discovery was incomplete",
  "unsupported-summary": "some session summaries were unsupported",
  "unresolved-repository-candidate": "some session repositories could not be resolved",
  "candidate-cap": "some eligible sessions were omitted from bounded inspection",
  "summary-coverage": "session coverage was incomplete",
  "partial-transcript": "a session transcript was partial",
  "corrupt-transcript": "a session transcript was corrupt or unreadable",
  "changed-during-read": "a session changed while it was read",
  "truncated-git-hunk": "the attributed Git change was truncated",
  "truncated-patch-payload": "a structured patch payload was truncated",
  "material-compaction": "session history was compacted",
  "material-rollback-or-abort": "session history includes a rollback or aborted turn",
};

interface SessionIdParts {
  readonly candidate: CorrelationCandidate;
  readonly encoded: string;
  readonly digest: string;
}

function encodeSessionId(sessionId: string): string {
  let encoded = "";
  for (let index = 0; index < sessionId.length; index += 1) {
    const code = sessionId.charCodeAt(index);
    const safe = (code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || code === 0x2d
      || code === 0x2e
      || code === 0x5f;
    encoded += safe
      ? String.fromCharCode(code)
      : `~${code.toString(16).padStart(4, "0")}`;
  }
  return encoded;
}

function sessionIdParts(candidate: CorrelationCandidate): SessionIdParts | null {
  const sessionId = candidate.session.sessionId;
  if (sessionId === null || sessionId.length === 0) return null;
  return {
    candidate,
    encoded: encodeSessionId(sessionId),
    digest: createHash("sha256").update(sessionId, "utf8").digest("hex"),
  };
}

function uniqueCandidates(candidates: readonly CorrelationCandidate[]): readonly CorrelationCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const sessionId = candidate.session.sessionId;
    if (sessionId === null || sessionId.length === 0 || seen.has(sessionId)) return false;
    seen.add(sessionId);
    return true;
  });
}

function labelSessionId(
  parts: SessionIdParts,
  prefixLength: number,
  hashLength: number,
  includeHash: boolean,
): string {
  if (parts.encoded.length <= prefixLength) return parts.encoded;
  const boundedPrefixLength = Math.min(
    prefixLength,
    MAX_RENDERED_SESSION_ID_LENGTH - 1 - (includeHash ? hashLength : 0),
  );
  const prefix = parts.encoded.slice(0, Math.max(1, boundedPrefixLength));
  return includeHash ? `${prefix}…${parts.digest.slice(0, hashLength)}` : `${prefix}…`;
}

function labelsAreUnique(labels: readonly string[]): boolean {
  return new Set(labels).size === labels.length;
}

function allocateSessionIds(
  candidates: readonly CorrelationCandidate[],
): ReadonlyMap<CorrelationCandidate, string> {
  const parts = uniqueCandidates(candidates)
    .map(sessionIdParts)
    .filter((value): value is SessionIdParts => value !== null);
  if (parts.length === 0) return new Map();
  if (parts.length === 1 && parts[0] !== undefined
    && parts[0].encoded.length <= MAX_RENDERED_SESSION_ID_LENGTH) {
    return new Map([[parts[0].candidate, parts[0].encoded]]);
  }

  const maximumPrefixLength = Math.min(
    MAX_RENDERED_SESSION_ID_LENGTH - 1,
    Math.max(...parts.map((value) => value.encoded.length)),
  );
  for (let prefixLength = Math.min(MIN_SESSION_ID_PREFIX, maximumPrefixLength);
    prefixLength <= maximumPrefixLength;
    prefixLength += 1) {
    const labels = parts.map((value) => labelSessionId(value, prefixLength, SESSION_ID_HASH_LENGTH, false));
    if (labelsAreUnique(labels)) {
      return new Map(parts.map((value, index) => [value.candidate, labels[index] as string]));
    }
  }

  for (let hashLength = SESSION_ID_HASH_LENGTH; hashLength <= MAX_SESSION_ID_HASH_LENGTH; hashLength += 1) {
    const labels = parts.map((value) => labelSessionId(
      value,
      MAX_RENDERED_SESSION_ID_LENGTH - 1 - hashLength,
      hashLength,
      true,
    ));
    if (labelsAreUnique(labels)) {
      return new Map(parts.map((value, index) => [value.candidate, labels[index] as string]));
    }
  }

  return new Map(parts.map((value) => [
    value.candidate,
    labelSessionId(value, 1, MAX_SESSION_ID_HASH_LENGTH, true),
  ]));
}

function candidateExplanations(candidate: CorrelationCandidate): readonly string[] {
  const explanations: string[] = [];
  for (const signal of [...candidate.signals, ...candidate.contradictions]) {
    const text = SIGNAL_TEXT[signal.kind];
    if (!explanations.includes(text)) explanations.push(text);
    if (explanations.length === MAX_RENDERED_EXPLANATIONS) break;
  }
  return explanations;
}

function renderCandidateEvidence(candidate: CorrelationCandidate): string | null {
  const explanations = candidateExplanations(candidate);
  return explanations.length === 0
    ? null
    : `  Evidence: ${explanations.join("; ")}`;
}

function renderCoverage(result: CorrelationResult): string {
  const limitations = result.coverage.limitations
    .map((limitation) => LIMITATION_TEXT[limitation.kind])
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, MAX_RENDERED_EXPLANATIONS);
  return limitations.length === 0
    ? `  Coverage: ${COVERAGE_TEXT[result.coverage.status]}`
    : `  Coverage: ${COVERAGE_TEXT[result.coverage.status]}; ${limitations.join("; ")}`;
}

function renderCandidateList(candidates: readonly CorrelationCandidate[]): string[] {
  const visible = uniqueCandidates(candidates).slice(0, MAX_RENDERED_CANDIDATES);
  const ids = allocateSessionIds(visible);
  const lines = ["  Candidates:"];
  for (const candidate of visible) {
    const id = ids.get(candidate);
    if (id !== undefined) lines.push(`    ${id}`);
  }
  return lines;
}

function appendPossibleCandidate(
  lines: string[],
  candidate: CorrelationCandidate,
): boolean {
  const id = allocateSessionIds([candidate]).get(candidate);
  if (id === undefined) return false;
  lines.push(`  Possible related session: ${id}`);
  const evidence = renderCandidateEvidence(candidate);
  if (evidence !== null) lines.push(evidence);
  lines.push("  Evidence is insufficient to claim a match.");
  return true;
}

function possibleCandidate(result: CorrelationResult): CorrelationCandidate | null {
  if (result.alternatives.length !== 1) return null;
  const candidate = result.alternatives[0];
  return candidate !== undefined && (candidate.band === "plausible" || candidate.band === "strong")
    ? candidate
    : null;
}

export function renderCorrelation(result: CorrelationResult): string {
  const lines = ["Codex evidence"];

  if (result.status === "matched" && result.selected !== undefined) {
    if (result.selected.band === "strong") {
      const id = allocateSessionIds([result.selected]).get(result.selected);
      if (id !== undefined) {
        lines.push(`  Likely related Codex session: ${id}`);
        const evidence = renderCandidateEvidence(result.selected);
        if (evidence !== null) lines.push(evidence);
      } else {
        lines.push(`  ${STATUS_TEXT[result.status]}`);
      }
    } else if (result.selected.band === "plausible") {
      if (!appendPossibleCandidate(lines, result.selected)) {
        lines.push(`  ${STATUS_TEXT[result.status]}`);
      }
    } else {
      lines.push(`  ${STATUS_TEXT[result.status]}`);
    }
  } else if (result.status === "none") {
    const possible = possibleCandidate(result);
    if (possible !== null) {
      if (!appendPossibleCandidate(lines, possible)) {
        lines.push(`  ${STATUS_TEXT[result.status]}`);
      }
    } else {
      lines.push(`  ${STATUS_TEXT[result.status]}`);
      if (result.alternatives.length > 1) lines.push(...renderCandidateList(result.alternatives));
    }
  } else if (result.status === "ambiguous") {
    lines.push(`  ${STATUS_TEXT[result.status]}`);
    lines.push(...renderCandidateList(result.alternatives));
  } else {
    lines.push(`  ${STATUS_TEXT[result.status]}`);
  }

  lines.push(renderCoverage(result));
  return lines.join("\n");
}
