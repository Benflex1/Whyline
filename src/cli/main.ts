#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { renderText, sanitizeTerminalText } from "./render-text.js";
import { analyzeLocation } from "../provenance/explain-location.js";
import { WhylineError } from "../whyline-error.js";

export async function runCli(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1) {
    process.stderr.write("whyline: expected exactly one location in the form <file>:<line>\n");
    return 2;
  }

  try {
    const report = await analyzeLocation(argv[0] as string);
    process.stdout.write(`${renderText(report)}\n`);
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
