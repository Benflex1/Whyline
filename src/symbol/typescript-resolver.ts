import type { CurrentSourceSnapshot } from "../location/resolve-location.js";
import { MAX_RANGE_LINES } from "../location/parse-location.js";
import { InvalidInputError, OperationalError, WhylineError } from "../whyline-error.js";
import {
  parseDeclarationIndex,
  supportedDialectForPath,
} from "./declaration-index.js";
import type {
  DeclarationFact,
  SymbolResolution,
} from "./model.js";

export { supportedDialectForPath } from "./declaration-index.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ambiguityMessage(
  selector: string,
  repositoryPath: string,
  matches: readonly SymbolResolution[],
): string {
  const shown = matches.slice(0, 12);
  const lines = shown.map((candidate) =>
    "  " + candidate.kind + "  " + candidate.qualifiedName
      + "  lines " + candidate.startLine + "-" + candidate.endLine);
  const omitted = matches.length - shown.length;
  if (omitted > 0) lines.push("  … omitted " + omitted + " candidate" + (omitted === 1 ? "" : "s"));
  lines.push("", "Use an exact qualified name where available; otherwise query one of the shown ranges.");
  const tick = String.fromCharCode(96);
  return "symbol " + tick + selector + tick + " is ambiguous in " + repositoryPath + "\n\nCandidates:\n" + lines.join("\n");
}

function toResolution(
  index: Awaited<ReturnType<typeof parseDeclarationIndex>>,
  candidate: DeclarationFact,
): SymbolResolution {
  return {
    language: index.language,
    dialect: index.dialect,
    parser: index.parser,
    parserVersion: index.parserVersion,
    kind: candidate.kind,
    name: candidate.name,
    qualifiedName: candidate.qualifiedName,
    startLine: candidate.span.startLine,
    endLine: candidate.span.endLine,
    boundary: "declaration-covering line span",
    ...(candidate.declarationForm === "const-function" ? { declarationForm: "const-function" } : {}),
  };
}

function selectSymbol(
  selector: string,
  repositoryPath: string,
  resolutions: readonly SymbolResolution[],
): SymbolResolution {
  const matches = resolutions
    .filter((candidate) => selector.includes(".")
      ? candidate.qualifiedName === selector
      : candidate.name === selector)
    .sort((left, right) => left.startLine - right.startLine
      || left.endLine - right.endLine
      || compareText(left.kind, right.kind)
      || compareText(left.qualifiedName, right.qualifiedName));
  if (matches.length === 0) {
    const tick = String.fromCharCode(96);
    throw new InvalidInputError("symbol " + tick + selector + tick + " was not found in " + repositoryPath);
  }
  if (matches.length > 1) {
    throw new InvalidInputError(ambiguityMessage(selector, repositoryPath, matches));
  }
  return matches[0] as SymbolResolution;
}

export async function resolveTypeScriptSymbol(
  selector: string,
  source: CurrentSourceSnapshot,
): Promise<SymbolResolution> {
  const selectorParts = selector.split(".");
  if (selector.length === 0 || selectorParts.some((part) => part.length === 0)) {
    throw new InvalidInputError("symbol selector must contain non-empty dot-separated components");
  }
  supportedDialectForPath(source.repositoryPath);
  try {
    const index = await parseDeclarationIndex(source.repositoryPath, source.text);
    const resolutions = index.declarations.map((candidate) => toResolution(index, candidate));
    const selected = selectSymbol(selector, source.repositoryPath, resolutions);
    const span = selected.endLine - selected.startLine + 1;
    if (span > MAX_RANGE_LINES) {
      throw new InvalidInputError(
        "symbol " + String.fromCharCode(96) + selector + String.fromCharCode(96)
          + " spans " + span + " lines ("
          + selected.startLine + "-" + selected.endLine + "); the current limit is " + MAX_RANGE_LINES + " lines",
      );
    }
    return selected;
  } catch (error: unknown) {
    if (error instanceof WhylineError) throw error;
    throw new OperationalError("TypeScript parser failed while resolving symbols");
  }
}
