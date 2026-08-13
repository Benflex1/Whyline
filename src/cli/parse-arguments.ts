import { InvalidInputError } from "../whyline-error.js";
import { parseLocationQuery } from "../location/parse-location.js";

export interface CliArguments {
  readonly details: boolean;
  readonly query: CliQuery;
}

export type CliQuery =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "location"; readonly location: string }
  | { readonly kind: "symbol"; readonly selector: string; readonly file: string };

function usageError(): InvalidInputError {
  return new InvalidInputError(
    "usage: whyline --help | whyline --version | whyline [--details] <file>:<line|start-end> | whyline [--details] --symbol <selector> <file>",
  );
}

function isValidLocation(value: string): boolean {
  try {
    parseLocationQuery(value);
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

function parseSelector(value: string | undefined): string {
  if (value === undefined || value === "--details" || value === "--symbol" || value.startsWith("-")) {
    throw usageError();
  }
  const components = value.split(".");
  if (value.length === 0 || components.some((component) => component.length === 0)) {
    throw new InvalidInputError("symbol selector must contain non-empty dot-separated components");
  }
  return value;
}

function parseSymbolFile(value: string | undefined): string {
  if (value === undefined || value === "--details" || value === "--symbol" || value.length === 0) {
    throw usageError();
  }
  return value;
}

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 1 && argv[0] === "--help") {
    return { details: false, query: { kind: "help" } };
  }

  if (argv.length === 1 && argv[0] === "--version") {
    return { details: false, query: { kind: "version" } };
  }

  if (argv.length === 1) {
    return { details: false, query: { kind: "location", location: parseLocationArgument(argv[0]) } };
  }

  if (argv.length === 2 && argv[0] === "--details") {
    return { details: true, query: { kind: "location", location: parseLocationArgument(argv[1]) } };
  }

  if (argv.length === 3 && argv[0] === "--symbol") {
    return {
      details: false,
      query: {
        kind: "symbol",
        selector: parseSelector(argv[1]),
        file: parseSymbolFile(argv[2]),
      },
    };
  }

  if (argv.length === 4 && argv[0] === "--details" && argv[1] === "--symbol") {
    return {
      details: true,
      query: {
        kind: "symbol",
        selector: parseSelector(argv[2]),
        file: parseSymbolFile(argv[3]),
      },
    };
  }

  throw usageError();
}
