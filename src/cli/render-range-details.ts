import type { RangeAncestrySegment, RangeCorrelationGroup, RangeTextualGroup, WhylineRangeReport } from "../provenance/range-model.js";
import { renderCorrelation } from "./render-correlation.js";
import { sanitizeTerminalText } from "./render-text.js";

const MAX_RENDERED_GROUPS = 64;

function spanText(group: Pick<RangeTextualGroup, "spans">): string {
  return group.spans.map((span) => span.startLine === span.endLine
    ? String(span.startLine)
    : span.startLine + "-" + span.endLine).join(", ");
}

function parentText(group: RangeTextualGroup): string {
  const parent = group.parent;
  if (parent === null) return "not applicable";
  if (parent.kind === "root") return "(root / empty tree)";
  if (parent.kind === "ambiguous") return "ambiguous (" + parent.parentIds.join(", ") + ")";
  if (parent.kind === "unavailable") return "unavailable (" + parent.reason + ")";
  return parent.commitId + " (" + parent.evidence + ")";
}

function omission(count: number): string {
  return "  … omitted " + count + " group" + (count === 1 ? "" : "s")
    + "; query a narrower range for the rest …";
}

function renderAncestrySegment(segment: RangeAncestrySegment): string[] {
  const span = segment.span.startLine === segment.span.endLine
    ? String(segment.span.startLine)
    : segment.span.startLine + "-" + segment.span.endLine;
  const lines = ["    " + span + "  status: " + segment.status];
  if (segment.transition !== undefined) lines.push("      transition: " + segment.transition);
  if (segment.candidate !== undefined) {
    lines.push("      candidate: " + sanitizeTerminalText(segment.candidate.commitId)
      + " " + sanitizeTerminalText(segment.candidate.path) + ":" + segment.candidate.line);
  }
  if (segment.ancestor !== undefined) {
    lines.push("      ancestor: " + sanitizeTerminalText(segment.ancestor.commitId)
      + " " + sanitizeTerminalText(segment.ancestor.path) + ":" + segment.ancestor.line);
  }
  if (segment.ancestorSubject !== undefined) {
    lines.push("      earlier attribution: " + sanitizeTerminalText(segment.ancestorSubject));
  }
  if (segment.proof !== undefined) {
    lines.push("      proof: lines=" + segment.proof.matchedLineCount
      + ", distinctive=" + segment.proof.distinctiveLineCount
      + ", alphanumeric=" + segment.proof.alphanumericCount
      + ", current=" + segment.proof.currentStartLine
      + ", ancestor=" + segment.proof.ancestorStartLine);
  }
  for (const limitation of segment.limitations) {
    lines.push("      limitation: " + sanitizeTerminalText(limitation));
  }
  return lines;
}

function renderTextualGroup(group: RangeTextualGroup): string[] {
  const lines = [
    "  Group " + sanitizeTerminalText(group.id) + "  lines: " + spanText(group),
    "    state: " + group.state,
    "    blamed path: " + sanitizeTerminalText(group.blamedPath ?? "(none)"),
    "    selected parent: " + sanitizeTerminalText(parentText(group)),
  ];
  if (group.commit !== null) {
    lines.push("    commit: " + sanitizeTerminalText(group.commit.id));
    lines.push("    subject: " + sanitizeTerminalText(group.commit.subject));
    lines.push("    author: " + sanitizeTerminalText(group.commit.authorName)
      + " <" + sanitizeTerminalText(group.commit.authorEmail) + ">");
    lines.push("    committed: " + sanitizeTerminalText(group.commit.committedAt));
  }
  lines.push("    line facts: " + String(group.lines.length));
  lines.push("    relevant hunks: " + String(group.relevantHunks.length));
  for (const hunk of group.relevantHunks.slice(0, 8)) {
    lines.push("      hunk: -" + hunk.oldStart + "," + hunk.oldLines
      + " +" + hunk.newStart + "," + hunk.newLines
      + " lines=" + hunk.lines.length + (hunk.truncated ? " truncated" : ""));
  }
  for (const limitation of group.limitations) {
    lines.push("    limitation: " + sanitizeTerminalText(limitation));
  }
  return lines;
}

function renderCorrelationGroup(
  group: RangeCorrelationGroup,
): string[] {
  const lines = [
    "  Group " + sanitizeTerminalText(group.groupId)
      + "  lines: " + group.spans.map((span) => span.startLine + "-" + span.endLine).join(", "),
    "    status: " + group.status,
  ];
  if (group.result !== undefined) {
    lines.push(...renderCorrelation(group.result).split("\n").map((line) => "    " + line));
  }
  for (const limitation of group.limitations) {
    lines.push("    limitation: " + sanitizeTerminalText(limitation));
  }
  return lines;
}

export function renderRangeDetails(report: WhylineRangeReport): string {
  const lines = [
    sanitizeTerminalText(report.location.repositoryPath) + ":"
      + report.location.startLine + "-" + report.location.endLine,
    "",
    "State",
    "  range lines: " + String(report.location.endLine - report.location.startLine + 1),
    "  HEAD: " + sanitizeTerminalText(report.repository.headCommit),
    "  branch: " + (report.repository.branch === null ? "detached" : sanitizeTerminalText(report.repository.branch)),
    "  target state: " + report.location.targetState,
    "",
    "Textual groups",
  ];
  const visibleTextual = report.textualGroups.slice(0, MAX_RENDERED_GROUPS);
  for (const group of visibleTextual) lines.push(...renderTextualGroup(group));
  if (report.textualGroups.length > MAX_RENDERED_GROUPS) {
    lines.push(omission(report.textualGroups.length - MAX_RENDERED_GROUPS));
  }

  lines.push("", "Exact ancestry");
  const visibleAncestry = report.textualGroups.slice(0, MAX_RENDERED_GROUPS);
  for (const group of visibleAncestry) {
    lines.push("  Group " + sanitizeTerminalText(group.id) + "  lines: " + spanText(group));
    const coverage = report.ancestry.get(group.id);
    if (coverage === undefined) {
      lines.push("    status: not-run");
    } else {
      for (const segment of coverage.segments) lines.push(...renderAncestrySegment(segment));
      for (const limitation of coverage.limitations) {
        lines.push("    limitation: " + sanitizeTerminalText(limitation));
      }
    }
  }
  if (report.textualGroups.length > MAX_RENDERED_GROUPS) {
    lines.push(omission(report.textualGroups.length - MAX_RENDERED_GROUPS));
  }

  lines.push("", "Codex provenance");
  for (const group of report.correlations.slice(0, MAX_RENDERED_GROUPS)) {
    lines.push(...renderCorrelationGroup(group));
  }
  if (report.correlations.length > MAX_RENDERED_GROUPS) {
    lines.push(omission(report.correlations.length - MAX_RENDERED_GROUPS));
  }

  lines.push("", "Analysis coverage");
  lines.push("  committed groups: " + report.coverage.committedGroups);
  lines.push("  deep analyzed groups: " + report.coverage.deepAnalyzedGroups);
  lines.push("  work-bound groups: " + report.coverage.workBoundGroups);
  lines.push("  uncommitted groups: " + report.coverage.uncommittedGroups);
  lines.push("  Raw prompts, reasoning, commands, transcript paths, and patch payloads are omitted.");
  return lines.join("\n");
}
