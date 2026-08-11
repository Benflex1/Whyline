import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments } from "../src/cli/parse-arguments.js";
import { InvalidInputError } from "../src/whyline-error.js";

test("parses the default location form", () => {
  assert.deepEqual(parseArguments(["src/parser.ts:42"]), {
    details: false,
    location: "src/parser.ts:42",
  });
});

test("parses details before the location", () => {
  assert.deepEqual(parseArguments(["--details", "src/parser.ts:42"]), {
    details: true,
    location: "src/parser.ts:42",
  });
});

test("keeps single-dash-leading paths usable as locations", () => {
  assert.deepEqual(parseArguments(["-leading.ts:1"]), {
    details: false,
    location: "-leading.ts:1",
  });
});

test("keeps double-dash-leading paths usable as locations", () => {
  assert.deepEqual(parseArguments(["--generated.ts:1"]), {
    details: false,
    location: "--generated.ts:1",
  });
  assert.deepEqual(parseArguments(["--details", "--generated.ts:1"]), {
    details: true,
    location: "--generated.ts:1",
  });
});

test("rejects unknown, repeated, misplaced, and missing flags as usage errors", () => {
  for (const argv of [
    [],
    ["--unknown"],
    ["--unknown", "src/parser.ts:42"],
    ["--details", "--details", "src/parser.ts:42"],
    ["src/parser.ts:42", "--details"],
    ["--details"],
  ]) {
    assert.throws(
      () => parseArguments(argv),
      (error: unknown) => error instanceof InvalidInputError && error.exitCode === 2,
      JSON.stringify(argv),
    );
  }
});
