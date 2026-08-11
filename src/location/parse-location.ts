import { InvalidInputError } from "../whyline-error.js";

export const MAX_RANGE_LINES = 200;

export interface ParsedLocation {
  readonly input: string;
  readonly file: string;
  readonly line: number;
}

export interface LineLocationQuery extends ParsedLocation {
  readonly kind: "line";
}

export interface RangeLocationQuery {
  readonly kind: "range";
  readonly input: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export type LocationQuery = LineLocationQuery | RangeLocationQuery;

function parsePositiveLine(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidInputError("line must be a positive one-based integer");
  }

  const line = Number(value);
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new InvalidInputError("line must be a positive one-based integer");
  }
  return line;
}

export function parseLocationQuery(input: string): LocationQuery {
  if (input.length === 0) {
    throw new InvalidInputError("location is required in the form <file>:<line>");
  }

  const separator = input.lastIndexOf(":");
  if (separator <= 0 || separator === input.length - 1) {
    throw new InvalidInputError("location must end with a positive line number");
  }

  const file = input.slice(0, separator);
  if (file.length === 0) {
    throw new InvalidInputError("location must name a file");
  }
  const lineText = input.slice(separator + 1);
  const range = /^([0-9]+)-([0-9]+)$/.exec(lineText);
  if (range !== null) {
    const startText = range[1];
    const endText = range[2];
    if (startText === undefined || endText === undefined) {
      throw new InvalidInputError("range must use positive ordered line numbers");
    }
    const startLine = parsePositiveLine(startText);
    const endLine = parsePositiveLine(endText);
    if (endLine < startLine) {
      throw new InvalidInputError("range lines must be ordered");
    }
    if (endLine - startLine + 1 > MAX_RANGE_LINES) {
      throw new InvalidInputError("range cannot exceed " + MAX_RANGE_LINES + " lines");
    }
    return {
      kind: "range",
      input,
      file,
      startLine,
      endLine,
    };
  }

  return {
    kind: "line",
    input,
    file,
    line: parsePositiveLine(lineText),
  };
}

export function parseLocation(input: string): ParsedLocation {
  const query = parseLocationQuery(input);
  if (query.kind === "range") {
    throw new InvalidInputError("location must identify one line");
  }
  return {
    input: query.input,
    file: query.file,
    line: query.line,
  };
}
