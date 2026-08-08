import { InvalidInputError } from "../whyline-error.js";

export interface ParsedLocation {
  readonly input: string;
  readonly file: string;
  readonly line: number;
}

export function parseLocation(input: string): ParsedLocation {
  if (input.length === 0) {
    throw new InvalidInputError("location is required in the form <file>:<line>");
  }

  const separator = input.lastIndexOf(":");
  if (separator <= 0 || separator === input.length - 1) {
    throw new InvalidInputError("location must end with a positive line number");
  }

  const file = input.slice(0, separator);
  const lineText = input.slice(separator + 1);
  if (!/^[0-9]+$/.test(lineText)) {
    throw new InvalidInputError("line must be a positive one-based integer");
  }

  const line = Number(lineText);
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new InvalidInputError("line must be a positive one-based integer");
  }

  return { input, file, line };
}
