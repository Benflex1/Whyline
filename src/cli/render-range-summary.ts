import type { CorrelationResult } from "../correlation/model.js";
import type { RangeAncestrySegment, RangeTextualGroup, WhylineRangeReport } from "../provenance/range-model.js";
import {
  renderCorrelationSummary,
  renderWorktreeCorrelationSummary,
} from "./render-correlation.js";
import { sanitizeTerminalText } from "./render-text.js";

const MAX_RENDERED_GROUPS = 12;

function spanText(group: Pick<RangeTextualGroup, "spans">): string {
  return group.spans.map((span) => span.startLine === span.endLine
    ? String(span.startLine)
    : span.startLine + "-" + span.endLine).join(", ");
}

function shortCommit(value: string): string {
  return sanitizeTerminalText(value).slice(0, 7);
}

function omission(count: number): string {
  return "  … omitted " + count + " group" + (count === 1 ? "" : "s")
    + "; query a narrower range for the rest …";
}

function renderTextualGroup(group: RangeTextualGroup): string {
  if (group.commit === null || group.state === "uncommitted") {
    return "  " + spanText(group) + "  uncommitted";
  }
  return "  " + spanText(group) + "  " + shortCommit(group.commit.id)
    + " \"" + sanitizeTerminalText(group.commit.subject) + "\"";
}

function renderAncestrySegment(segment: RangeAncestrySegment): string {
  const span = segment.span.startLine === segment.span.endLine
    ? String(segment.span.startLine)
    : segment.span.startLine + "-" + segment.span.endLine;
  switch (segment.status) {
    case "exact":
      const ancestorPath = segment.ancestor === undefined ? "(unknown path)" : segment.ancestor.path;
      return "    " + span + "  exact predecessor at "
        + sanitizeTerminalText(ancestorPath)
        + ":" + (segment.ancestor?.line ?? "?")
        + " " + shortCommit(segment.ancestor?.commitId ?? "")
        + " \"" + sanitizeTerminalText(segment.ancestorSubject ?? "") + "\"";
    case "transformed":
      return "    " + span + "  verified direct-parent declaration correspondence; queried line is not an exact ancestor match";
    case "uncertain":
      return "    " + span + "  uncertain; exact ancestry not established";
    case "none":
      return "    " + span + "  not established";
    case "unavailable":
      return "    " + span + "  unavailable";
    case "not-run":
      return "    " + span + "  not run";
    case "work-bound":
      return "    " + span + "  unavailable / work-bound";
  }
}

function renderCorrelationResult(
  span: string,
  result: CorrelationResult,
  targetKind: "commit" | "worktree",
): string[] {
  const rendered = targetKind === "worktree"
    ? renderWorktreeCorrelationSummary(result)
    : renderCorrelationSummary(result);
  const first = rendered[0]?.trim() ?? "AI provenance: no reliable Codex match";
  return [
    "    " + span + "  " + first,
    ...rendered.slice(1).map((line) => "      " + line.trim()),
  ];
}

export function renderRangeSummaryWithHeader(
  report: WhylineRangeReport,
  header: string,
): string {
  const lines = [
    header,
    "",
    "Explanation",
    "  Textual last-touch",
  ];
  const visibleTextual = report.textualGroups.slice(0, MAX_RENDERED_GROUPS);
  lines.push(...visibleTextual.map(renderTextualGroup));
  if (report.textualGroups.length > MAX_RENDERED_GROUPS) {
    lines.push(omission(report.textualGroups.length - MAX_RENDERED_GROUPS));
  }

  lines.push("", "  Git ancestry");
  for (const group of visibleTextual) {
    const coverage = report.ancestry.get(group.id);
    if (coverage === undefined) {
      lines.push("    " + spanText(group) + "  not run");
      continue;
    }
    lines.push(...coverage.segments.map(renderAncestrySegment));
  }
  if (report.textualGroups.length > MAX_RENDERED_GROUPS) {
    lines.push(omission(report.textualGroups.length - MAX_RENDERED_GROUPS));
  }

  lines.push("", "  AI provenance");
  const correlationByTextualGroup = new Map<string, readonly typeof report.correlations[number][]>();
  for (const correlation of report.correlations) {
    const existing = correlationByTextualGroup.get(correlation.textualGroupId) ?? [];
    correlationByTextualGroup.set(correlation.textualGroupId, [...existing, correlation]);
  }
  for (const group of visibleTextual) {
    const correlations = correlationByTextualGroup.get(group.id) ?? [];
    if (correlations.length === 0) {
      lines.push("    " + spanText(group) + "  not run");
    } else {
      for (const correlation of correlations) {
        const span = correlation.spans.map((value) => value.startLine === value.endLine
          ? String(value.startLine)
          : value.startLine + "-" + value.endLine).join(", ");
        if (correlation.status === "not-run") {
          lines.push("    " + span + "  not run");
        } else if (correlation.status === "work-bound") {
          lines.push("    " + span + "  unavailable / work-bound");
        } else if (correlation.status === "insufficient") {
          lines.push("    " + span + "  not established; worktree material is insufficient");
        } else if (correlation.result !== undefined) {
          lines.push(...renderCorrelationResult(span, correlation.result, correlation.targetKind));
        } else {
          lines.push("    " + span + "  unavailable");
        }
      }
    }
  }
  if (report.textualGroups.length > MAX_RENDERED_GROUPS) {
    lines.push(omission(report.textualGroups.length - MAX_RENDERED_GROUPS));
  }
  return lines.join("\n");
}

export function renderRangeSummary(report: WhylineRangeReport): string {
  return renderRangeSummaryWithHeader(
    report,
    sanitizeTerminalText(report.location.repositoryPath) + ":"
      + report.location.startLine + "-" + report.location.endLine,
  );
}
