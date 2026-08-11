#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { parseArguments } from "./parse-arguments.js";
import { renderRangeDetails } from "./render-range-details.js";
import { renderRangeSummary } from "./render-range-summary.js";
import { renderSummary } from "./render-summary.js";
import { renderText, sanitizeTerminalText } from "./render-text.js";
import { parseLocationQuery } from "../location/parse-location.js";
import { analyzeLocation } from "../provenance/explain-location.js";
import { analyzeRange } from "../provenance/explain-range.js";
import { WhylineError } from "../whyline-error.js";

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    const query = parseLocationQuery(parsed.location);
    if (query.kind === "range") {
      const report = await analyzeRange(parsed.location);
      process.stdout.write(`${parsed.details ? renderRangeDetails(report) : renderRangeSummary(report)}\n`);
    } else {
      const report = await analyzeLocation(parsed.location);
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
