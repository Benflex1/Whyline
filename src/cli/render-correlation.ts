import type {
  CorrelationCandidate,
  CorrelationLimitationKind,
  CorrelationResult,
  CorrelationSignalKind,
} from "../correlation/model.js";

const MIN_SESSION_ID_PREFIX = 8;
const MAX_RENDERED_CANDIDATES = 8;
const MAX_RENDERED_EXPLANATIONS = 4;

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

function safeSessionId(sessionId: string | null): string | null {
  if (sessionId === null || sessionId.length === 0) return null;
  const safe = sessionId.replace(/[^A-Za-z0-9._~-]/g, "_");
  return safe.length === 0 ? null : safe;
}

function candidateId(candidate: CorrelationCandidate): string | null {
  return safeSessionId(candidate.session.sessionId);
}

function displayedIds(candidates: readonly CorrelationCandidate[]): readonly string[] {
  const ids = candidates
    .map(candidateId)
    .filter((value): value is string => value !== null);
  if (ids.length === 0) return [];

  const minimum = Math.min(MIN_SESSION_ID_PREFIX, Math.max(...ids.map((id) => id.length)));
  const maximum = Math.max(...ids.map((id) => id.length));
  for (let length = minimum; length <= maximum; length += 1) {
    const labels = ids.map((id) => id.length <= length ? id : `${id.slice(0, length)}…`);
    if (new Set(labels).size === labels.length) return labels;
  }
  return ids;
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
  const visible = candidates.slice(0, MAX_RENDERED_CANDIDATES);
  const ids = displayedIds(visible);
  const lines = ["  Candidates:"];
  let displayed = 0;
  for (let index = 0; index < visible.length; index += 1) {
    const candidate = visible[index];
    const id = ids[displayed];
    if (candidate === undefined || id === undefined) continue;
    lines.push(`    ${id}`);
    displayed += 1;
  }
  return lines;
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
    const id = candidateId(result.selected);
    if (id !== null) {
      lines.push(`  Likely related Codex session: ${id}`);
      const evidence = renderCandidateEvidence(result.selected);
      if (evidence !== null) lines.push(evidence);
    } else {
      lines.push(`  ${STATUS_TEXT[result.status]}`);
    }
  } else if (result.status === "none") {
    const possible = possibleCandidate(result);
    if (possible !== null) {
      const id = candidateId(possible);
      if (id !== null) {
        lines.push(`  Possible related session: ${id}`);
        const evidence = renderCandidateEvidence(possible);
        if (evidence !== null) lines.push(evidence);
      } else {
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
