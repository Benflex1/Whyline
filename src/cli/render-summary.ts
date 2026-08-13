import type { GitAncestryResult } from "../ancestry/model.js";
import type { WhylineReport } from "../provenance/model.js";
import {
  renderCorrelationSummary,
  renderWorktreeCorrelationSummary,
} from "./render-correlation.js";
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
      return [
        "  Git ancestry: edited declaration has a verified parent correspondence",
        "    declaration: " + ancestry.childDeclaration.kind + " "
          + sanitizeTerminalText(ancestry.childDeclaration.qualifiedName)
          + " lines " + ancestry.childDeclaration.span.startLine + "-" + ancestry.childDeclaration.span.endLine,
        "    parent: " + shortCommit(ancestry.parentCommitId) + " "
          + sanitizeTerminalText(ancestry.parentPath) + ":"
          + ancestry.parentDeclaration.span.startLine + "-" + ancestry.parentDeclaration.span.endLine,
        "    evidence: target edit hunk + exact preserved declaration anchor",
        "    limitation: the queried line itself is not an exact ancestor match",
      ];
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
  if (report.worktreeCorrelation !== undefined) {
    const worktree = report.worktreeCorrelation;
    const lastTouch = worktree.changeKind === "added" && report.location.targetState === "untracked"
      ? "  Textual last-touch: uncommitted; file is untracked"
      : `  Textual last-touch: uncommitted; modified against HEAD ${shortCommit(worktree.baseCommitId)}`;
    lines.push(lastTouch);
    lines.push("  Git ancestry: not run for an uncommitted line");
    if (worktree.construction === "insufficient") {
      lines.push("  AI provenance: not established; worktree material is insufficient");
      if (worktree.limitations[0] !== undefined) {
        lines.push(`    ${sanitizeTerminalText(worktree.limitations[0])}`);
      }
    } else if (worktree.construction === "work-bound") {
      lines.push("  AI provenance: unavailable / work-bound");
    } else if (worktree.construction === "unavailable") {
      lines.push("  AI provenance: unavailable");
    } else if (worktree.result !== undefined) {
      lines.push(...renderWorktreeCorrelationSummary(worktree.result));
    } else {
      lines.push("  AI provenance: not established");
    }
  } else if (report.provenance.commit === null || report.provenance.blame === null) {
    lines.push("  Textual last-touch: uncommitted");
  } else {
    lines.push(`  Textual last-touch: ${shortCommit(report.provenance.commit.id)} \"${sanitizeTerminalText(report.provenance.commit.subject)}\"`);
  }
  if (report.worktreeCorrelation === undefined) lines.push(...renderAncestrySummary(report.ancestry));
  if (report.worktreeCorrelation !== undefined) {
    return lines.join("\n");
  }
  if (report.correlation === undefined) {
    lines.push("  AI provenance: not run");
  } else {
    lines.push(...renderCorrelationSummary(report.correlation));
  }
  return lines.join("\n");
}
