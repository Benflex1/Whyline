import { sanitizeTerminalText } from "./render-text.js";
import { renderRangeSummaryWithHeader } from "./render-range-summary.js";
import type { WhylineSymbolReport } from "../provenance/explain-symbol.js";

export function renderSymbolSummary(report: WhylineSymbolReport): string {
  const header = [
    `${sanitizeTerminalText(report.range.location.repositoryPath)} — ${sanitizeTerminalText(report.symbol.qualifiedName)}`,
    `${report.symbol.kind}, lines ${report.symbol.startLine}-${report.symbol.endLine}`,
  ].join("\n");
  return renderRangeSummaryWithHeader(report.range, header);
}
