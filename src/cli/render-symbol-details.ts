import { renderRangeDetailsWithHeader } from "./render-range-details.js";
import { sanitizeTerminalText } from "./render-text.js";
import type { WhylineSymbolReport } from "../provenance/explain-symbol.js";

function languageLabel(language: WhylineSymbolReport["symbol"]["language"]): string {
  return language === "typescript" ? "TypeScript" : "JavaScript";
}

export function renderSymbolDetails(report: WhylineSymbolReport): string {
  const symbol = report.symbol;
  const path = sanitizeTerminalText(report.range.location.repositoryPath);
  const qualifiedName = sanitizeTerminalText(symbol.qualifiedName);
  const header = [
    `${path} — ${qualifiedName}`,
    `${symbol.kind}, lines ${symbol.startLine}-${symbol.endLine}`,
    "",
    "Symbol resolution",
    `  language: ${languageLabel(symbol.language)}`,
    `  dialect: ${symbol.dialect}`,
    `  parser: TypeScript ${sanitizeTerminalText(symbol.parserVersion)}`,
    `  selector: ${sanitizeTerminalText(report.selector)}`,
    `  qualified name: ${qualifiedName}`,
    `  resolved range: ${path}:${symbol.startLine}-${symbol.endLine}`,
    `  boundary: ${symbol.boundary}`,
    "  limitation: current-worktree syntax resolution only; no historical symbol identity is inferred",
    "  limitation: provenance is line-granular; other text or trivia sharing the first or last resolved line is included",
  ];
  return renderRangeDetailsWithHeader(report.range, header);
}
