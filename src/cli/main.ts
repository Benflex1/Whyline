#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { parseArguments } from "./parse-arguments.js";
import { readPackageVersion } from "./package-manifest.js";
import { renderRangeDetails } from "./render-range-details.js";
import { renderRangeSummary } from "./render-range-summary.js";
import { renderSymbolDetails } from "./render-symbol-details.js";
import { renderSymbolSummary } from "./render-symbol-summary.js";
import { renderSummary } from "./render-summary.js";
import { renderHelp } from "./render-help.js";
import { renderText, sanitizeTerminalText } from "./render-text.js";
import { parseLocationQuery } from "../location/parse-location.js";
import { analyzeLocation } from "../provenance/explain-location.js";
import { analyzeRange } from "../provenance/explain-range.js";
import { analyzeSymbol } from "../provenance/explain-symbol.js";
import { WhylineError } from "../whyline-error.js";

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    if (parsed.query.kind === "help") {
      process.stdout.write(`${renderHelp()}\n`);
      return 0;
    }
    if (parsed.query.kind === "version") {
      process.stdout.write(`${await readPackageVersion()}\n`);
      return 0;
    }
    if (parsed.query.kind === "symbol") {
      const report = await analyzeSymbol(parsed.query.selector, parsed.query.file);
      process.stdout.write(`${parsed.details ? renderSymbolDetails(report) : renderSymbolSummary(report)}\n`);
      return 0;
    }
    const query = parseLocationQuery(parsed.query.location);
    if (query.kind === "range") {
      const report = await analyzeRange(parsed.query.location);
      process.stdout.write(`${parsed.details ? renderRangeDetails(report) : renderRangeSummary(report)}\n`);
    } else {
      const report = await analyzeLocation(parsed.query.location);
      process.stdout.write(`${parsed.details ? renderText(report) : renderSummary(report)}\n`);
    }
    return 0;
  } catch (error: unknown) {
    if (error instanceof WhylineError) {
      process.stderr.write(`whyline: ${sanitizeTerminalText(error.message)}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : "unexpected failure";
    process.stderr.write(`whyline: ${sanitizeTerminalText(message)}\n`);
    return 3;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
