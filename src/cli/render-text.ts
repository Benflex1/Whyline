import type {
  GitDiffLine,
  GitHunk,
  GitPathChange,
  WhylineReport,
} from "../provenance/model.js";
import type { GitAncestryResult } from "../ancestry/model.js";
import { renderCorrelation } from "./render-correlation.js";

const MAX_RENDERED_CHANGES = 24;
const MAX_RENDERED_HUNK_LINES = 28;
const MAX_RENDERED_BODY_LINES = 4;
const MAX_RENDERED_VALUE_LENGTH = 480;

export function sanitizeTerminalText(value: string, maxLength = MAX_RENDERED_VALUE_LENGTH): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}…` : sanitized;
}

function identity(name: string, email: string): string {
  const safeName = sanitizeTerminalText(name);
  const safeEmail = sanitizeTerminalText(email);
  return safeEmail.length === 0 ? safeName : `${safeName} <${safeEmail.replace(/^<|>$/g, "")}>`;
}

function pathChange(change: GitPathChange): string {
  const oldPath = change.oldPath === null ? null : sanitizeTerminalText(change.oldPath);
  const newPath = change.newPath === null ? null : sanitizeTerminalText(change.newPath);
  const status = change.kind === "renamed"
    ? "R"
    : change.kind === "copied"
      ? "C"
      : change.kind === "added"
        ? "A"
        : change.kind === "deleted"
          ? "D"
          : change.kind === "type-changed"
            ? "T"
            : change.kind === "unmerged"
              ? "U"
              : change.kind === "modified"
                ? "M"
                : "?";
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    return `${status} ${oldPath} -> ${newPath}`;
  }
  return `${status} ${newPath ?? oldPath ?? "(unknown path)"}`;
}

function range(start: number, count: number): string {
  if (count === 0) return `${start}..${start}`;
  return `${start}..${start + count - 1}`;
}

function parentDescription(report: WhylineReport): string {
  const parent = report.provenance.parent;
  if (parent === null) return "not applicable";
  if (parent.kind === "root") return "(empty tree; root commit)";
  if (parent.kind === "ambiguous") return "ambiguous";
  if (parent.kind === "unavailable") return "unavailable (shallow history)";
  return parent.commitId;
}

function diffLine(line: GitDiffLine): string {
  const prefix = line.kind === "added"
    ? "+"
    : line.kind === "deleted"
      ? "-"
      : line.kind === "context"
        ? " "
        : " ";
  return `${prefix}${sanitizeTerminalText(line.text)}`;
}

function renderHunk(hunk: GitHunk): string[] {
  const lines = [
    `  hunk: -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)}${hunk.targetLineKind === null ? "" : ` (target is ${hunk.targetLineKind})`}`,
  ];
  for (const line of hunk.lines.slice(0, MAX_RENDERED_HUNK_LINES)) {
    lines.push(`    ${diffLine(line)}`);
  }
  if (hunk.lines.length > MAX_RENDERED_HUNK_LINES || hunk.truncated) {
    lines.push("    … diff hunk output bounded …");
  }
  return lines;
}

function renderBody(body: string): string[] {
  const lines = body.split(/\r?\n/).filter((line) => line.length > 0).slice(0, MAX_RENDERED_BODY_LINES);
  return lines.map((line) => `  ${sanitizeTerminalText(line)}`);
}

function renderAncestryDetails(ancestry: GitAncestryResult | undefined): string[] {
  const lines = ["", "Git ancestry"];
  if (ancestry === undefined) {
    lines.push("  not run for an uncommitted target");
    return lines;
  }
  lines.push(`  status: ${ancestry.status}`);
  switch (ancestry.status) {
    case "exact":
      lines.push(`  transition: ${ancestry.transition}`);
      lines.push(`  ancestor: ${sanitizeTerminalText(ancestry.ancestor.commitId)} ${sanitizeTerminalText(ancestry.ancestor.path)}:${ancestry.ancestor.line}`);
      lines.push(`  earlier attribution: ${sanitizeTerminalText(ancestry.ancestorSubject)}`);
      lines.push(`  proof: lines=${ancestry.proof.matchedLineCount}, distinctive=${ancestry.proof.distinctiveLineCount}, alphanumeric=${ancestry.proof.alphanumericCount}, current=${ancestry.proof.currentStartLine}, ancestor=${ancestry.proof.ancestorStartLine}`);
      break;
    case "transformed":
      lines.push("  relationship: direct-parent-declaration");
      lines.push(`  textual commit: ${sanitizeTerminalText(ancestry.textualCommitId)}`);
      lines.push(`  parent commit: ${sanitizeTerminalText(ancestry.parentCommitId)}`);
      lines.push(`  child path: ${sanitizeTerminalText(ancestry.childPath)}`);
      lines.push(`  parent path: ${sanitizeTerminalText(ancestry.parentPath)}`);
      lines.push(`  child declaration: ${ancestry.childDeclaration.kind} ${sanitizeTerminalText(ancestry.childDeclaration.qualifiedName)} lines ${ancestry.childDeclaration.span.startLine}-${ancestry.childDeclaration.span.endLine}`);
      lines.push(`  parent declaration: ${ancestry.parentDeclaration.kind} ${sanitizeTerminalText(ancestry.parentDeclaration.qualifiedName)} lines ${ancestry.parentDeclaration.span.startLine}-${ancestry.parentDeclaration.span.endLine}`);
      lines.push(`  syntactic key: kind=${ancestry.childDeclaration.kind}, qualified-name=${sanitizeTerminalText(ancestry.childDeclaration.qualifiedName)}, form=${ancestry.childDeclaration.declarationForm}, staticness=${ancestry.childDeclaration.staticStatus === null ? "not-applicable" : ancestry.childDeclaration.staticStatus}`);
      lines.push(`  selected parent evidence: ${ancestry.parentSelectionEvidence}`);
      lines.push(`  hunk: connection=${ancestry.hunk.connection}, old=${ancestry.hunk.oldStart},${ancestry.hunk.oldLines}, new=${ancestry.hunk.newStart},${ancestry.hunk.newLines}`);
      lines.push(`  anchor: lines=${ancestry.anchor.matchedLineCount}, distinctive=${ancestry.anchor.distinctiveLineCount}, alphanumeric=${ancestry.anchor.alphanumericCount}`);
      lines.push("  limitation: the queried line itself is not an exact ancestor match");
      break;
    case "uncertain":
      lines.push(`  reason: ${ancestry.reason}`);
      if (ancestry.candidate !== undefined) {
        lines.push(`  candidate: ${sanitizeTerminalText(ancestry.candidate.commitId)} ${sanitizeTerminalText(ancestry.candidate.path)}:${ancestry.candidate.line}`);
      }
      break;
    case "none":
      lines.push(`  reason: ${ancestry.reason}`);
      break;
    case "unavailable":
      lines.push(`  reason: ${ancestry.reason}`);
      if (ancestry.candidate !== undefined) {
        lines.push(`  candidate: ${sanitizeTerminalText(ancestry.candidate.commitId)} ${sanitizeTerminalText(ancestry.candidate.path)}:${ancestry.candidate.line}`);
      }
      break;
  }
  for (const value of [...new Set(ancestry.limitations)]) {
    lines.push(`  limitation: ${sanitizeTerminalText(value)}`);
  }
  return lines;
}

export function renderText(report: WhylineReport): string {
  const { location, provenance } = report;
  const output: string[] = [`${sanitizeTerminalText(location.repositoryPath)}:${location.requestedLine}`, "", "State"];
  output.push(`  ${provenance.state}`);
  output.push(`  HEAD: ${sanitizeTerminalText(report.repository.headCommit)}`);
  output.push(`  branch: ${report.repository.branch === null ? "detached" : sanitizeTerminalText(report.repository.branch)}`);
  if (provenance.targetState === "clean") {
    output.push("  file is clean");
  } else if (provenance.targetState === "untracked") {
    output.push("  file is untracked");
  } else if (provenance.targetState === "deleted") {
    output.push("  file is marked deleted in Git");
  } else if (provenance.targetState === "unmerged") {
    output.push("  file has unresolved merge state");
  } else {
    output.push("  file has uncommitted changes");
  }
  output.push(`  current line: ${location.lineContent.length === 0 ? "(empty)" : sanitizeTerminalText(location.lineContent)}`);

  output.push("", "Textual attribution");
  if (provenance.commit === null || provenance.blame === null) {
    output.push("  Uncommitted");
  } else {
    output.push(`  ${sanitizeTerminalText(provenance.commit.id)} ${sanitizeTerminalText(provenance.commit.subject)}`);
    output.push(`  Author: ${identity(provenance.commit.authorName, provenance.commit.authorEmail)}`);
    output.push(`  Authored: ${sanitizeTerminalText(provenance.commit.authoredAt)}`);
    output.push(`  Committer: ${identity(provenance.commit.committerName, provenance.commit.committerEmail)}`);
    output.push(`  Committed: ${sanitizeTerminalText(provenance.commit.committedAt)}`);
    output.push(`  Parents: ${provenance.commit.parents.length === 0 ? "(root)" : provenance.commit.parents.join(", ")}`);
    if (provenance.commit.body.length > 0) {
      output.push("  Body:", ...renderBody(provenance.commit.body));
    }
  }

  if (provenance.blame !== null) {
    output.push("", "Original location");
    output.push(`  ${sanitizeTerminalText(provenance.blame.filename)}:${provenance.blame.originalLine}`);
  }

  output.push(...renderAncestryDetails(report.ancestry));

  output.push("", "Relevant change");
  output.push(`  parent: ${sanitizeTerminalText(parentDescription(report))}`);
  if (provenance.changedPaths.length === 0) {
    output.push("  changed paths: none available");
  } else {
    output.push("  changed paths:");
    for (const change of provenance.changedPaths.slice(0, MAX_RENDERED_CHANGES)) {
      output.push(`    ${pathChange(change)}`);
    }
    if (provenance.changedPaths.length > MAX_RENDERED_CHANGES) {
      output.push(`    … ${provenance.changedPaths.length - MAX_RENDERED_CHANGES} more paths …`);
    }
  }
  if (provenance.relevantHunks.length === 0) {
    output.push("  hunk: none available");
  } else {
    output.push(...renderHunk(provenance.relevantHunks[0] as GitHunk));
    if (provenance.relevantHunks.length > 1) {
      output.push(`  (${provenance.relevantHunks.length - 1} additional relevant hunk(s) omitted)`);
    }
  }

  output.push("", "Limitations");
  for (const limitation of [...new Set(provenance.limitations)]) {
    output.push(`  ${sanitizeTerminalText(limitation)}`);
  }
  if (provenance.state === "committed" && report.correlation !== undefined) {
    output.push("", ...renderCorrelation(report.correlation).split("\n"));
  }
  return output.join("\n");
}

export function renderDetails(report: WhylineReport): string {
  return renderText(report);
}
