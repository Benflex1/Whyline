import type { GitAncestryResult } from "../ancestry/model.js";
import type { WhylineReport } from "../provenance/model.js";
import { renderCorrelationSummary } from "./render-correlation.js";
import { sanitizeTerminalText } from "./render-text.js";

function shortCommit(value: string): string {
  return sanitizeTerminalText(value).slice(0, 7);
}

function renderAncestrySummary(ancestry: GitAncestryResult | undefined): string[] {
  if (ancestry === undefined) {
    return ["  Git ancestry: unavailable; the queried target is uncommitted"];
  }
  switch (ancestry.status) {
    case "exact":
      return [
        "  Git ancestry: exact code predates that commit",
        `    transition: ${ancestry.transition}`,
        `    moved/copied from ${sanitizeTerminalText(ancestry.ancestor.path)}:${ancestry.ancestor.line}`,
        `    earlier attribution: ${shortCommit(ancestry.ancestor.commitId)} \"${sanitizeTerminalText(ancestry.ancestorSubject)}\"`,
      ];
    case "uncertain":
      return ["  Git ancestry: uncertain; Git suggested movement but exact verification was insufficient"];
    case "transformed":
      return ["  Git ancestry: verified direct-parent declaration correspondence; the queried line is not an exact ancestor match"];
    case "none":
      return ["  Git ancestry: not established; the textual commit may be origin or transformation"];
    case "unavailable":
      return [`  Git ancestry: unavailable; ${ancestry.reason.replaceAll("-", " ")}`];
  }
}

export function renderSummary(report: WhylineReport): string {
  const lines = [
    `${sanitizeTerminalText(report.location.repositoryPath)}:${report.location.requestedLine}`,
    "",
    "Explanation",
  ];
  if (report.provenance.commit === null || report.provenance.blame === null) {
    lines.push("  Textual last-touch: uncommitted");
  } else {
    lines.push(`  Textual last-touch: ${shortCommit(report.provenance.commit.id)} \"${sanitizeTerminalText(report.provenance.commit.subject)}\"`);
  }
  lines.push(...renderAncestrySummary(report.ancestry));
  if (report.correlation === undefined) {
    lines.push("  AI provenance: not run");
  } else {
    lines.push(...renderCorrelationSummary(report.correlation));
  }
  return lines.join("\n");
}
