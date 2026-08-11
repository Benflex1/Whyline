import { defaultGitProcess, type GitRunner } from "../git/git-process.js";
import { discoverRepositoryContext } from "../git/repository-context.js";
import {
  resolveCurrentSource,
  resolvedRangeLocationFromSource,
} from "../location/resolve-location.js";
import type { RangeLocationQuery } from "../location/parse-location.js";
import type { WhylineRangeReport } from "./range-model.js";
import {
  analyzeResolvedRange,
  type AnalyzeRangeOptions,
} from "./explain-range.js";
import type { SymbolResolution } from "../symbol/model.js";
import { resolveTypeScriptSymbol } from "../symbol/typescript-resolver.js";

export interface AnalyzeSymbolOptions extends AnalyzeRangeOptions {
  readonly git?: GitRunner;
}

export interface WhylineSymbolReport {
  readonly selector: string;
  readonly symbol: SymbolResolution;
  readonly range: WhylineRangeReport;
}

export async function analyzeSymbol(
  selector: string,
  file: string,
  options: AnalyzeSymbolOptions = {},
): Promise<WhylineSymbolReport> {
  const runner = options.git ?? defaultGitProcess;
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const repository = await discoverRepositoryContext(runner, currentDirectory);
  const source = await resolveCurrentSource(file, repository, runner, currentDirectory);
  const symbol = await resolveTypeScriptSymbol(selector, source);
  const rangeQuery: RangeLocationQuery = {
    kind: "range",
    input: `${source.repositoryPath}:${symbol.startLine}-${symbol.endLine}`,
    file: source.repositoryPath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  };
  const location = resolvedRangeLocationFromSource(rangeQuery, source);
  const range = await analyzeResolvedRange(repository, location, options);
  return { selector, symbol, range };
}
