import { InvalidInputError } from "../whyline-error.js";

export interface CliArguments {
  readonly details: boolean;
  readonly location: string;
}

function usageError(): InvalidInputError {
  return new InvalidInputError("usage: whyline [--details] <file>:<line>");
}

function isUnsupportedFlag(value: string): boolean {
  return value.startsWith("--");
}

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 1) {
    const location = argv[0];
    if (location === undefined || location === "--details" || isUnsupportedFlag(location)) {
      throw usageError();
    }
    return { details: false, location };
  }

  if (argv.length === 2 && argv[0] === "--details") {
    const location = argv[1];
    if (location === undefined || location === "--details" || isUnsupportedFlag(location)) {
      throw usageError();
    }
    return { details: true, location };
  }

  throw usageError();
}
