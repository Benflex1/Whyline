import { InvalidInputError } from "../whyline-error.js";
import { parseLocation } from "../location/parse-location.js";

export interface CliArguments {
  readonly details: boolean;
  readonly location: string;
}

function usageError(): InvalidInputError {
  return new InvalidInputError("usage: whyline [--details] <file>:<line>");
}

function isValidLocation(value: string): boolean {
  try {
    parseLocation(value);
    return true;
  } catch {
    return false;
  }
}

function parseLocationArgument(value: string | undefined): string {
  if (value === undefined || value === "--details") {
    throw usageError();
  }
  if (value.startsWith("--") && !isValidLocation(value)) {
    throw usageError();
  }
  return value;
}

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 1) {
    return { details: false, location: parseLocationArgument(argv[0]) };
  }

  if (argv.length === 2 && argv[0] === "--details") {
    return { details: true, location: parseLocationArgument(argv[1]) };
  }

  throw usageError();
}
