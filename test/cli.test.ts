import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments } from "../src/cli/parse-arguments.js";
import { InvalidInputError } from "../src/whyline-error.js";

test("parses the default location form", () => {
  assert.deepEqual(parseArguments(["src/parser.ts:42"]), {
    details: false,
    query: { kind: "location", location: "src/parser.ts:42" },
  });
});

test("parses help and version commands without a repository query", () => {
  assert.deepEqual(parseArguments(["--help"]), {
    details: false,
    query: { kind: "help" },
  });
  assert.deepEqual(parseArguments(["--version"]), {
    details: false,
    query: { kind: "version" },
  });
});

test("parses details before the location", () => {
  assert.deepEqual(parseArguments(["--details", "src/parser.ts:42"]), {
    details: true,
    query: { kind: "location", location: "src/parser.ts:42" },
  });
});

test("keeps single-dash-leading paths usable as locations", () => {
  assert.deepEqual(parseArguments(["-leading.ts:1"]), {
    details: false,
    query: { kind: "location", location: "-leading.ts:1" },
  });
});

test("keeps double-dash-leading paths usable as locations", () => {
  assert.deepEqual(parseArguments(["--generated.ts:1"]), {
    details: false,
    query: { kind: "location", location: "--generated.ts:1" },
  });
  assert.deepEqual(parseArguments(["--details", "--generated.ts:1"]), {
    details: true,
    query: { kind: "location", location: "--generated.ts:1" },
  });
});

test("parses a symbol query with a separate file argument", () => {
  assert.deepEqual(parseArguments(["--symbol", "Parser.parseToken", "src/parser.ts"]), {
    details: false,
    query: { kind: "symbol", selector: "Parser.parseToken", file: "src/parser.ts" },
  });
  assert.deepEqual(parseArguments(["--details", "--symbol", "parseToken", "src/parser.ts"]), {
    details: true,
    query: { kind: "symbol", selector: "parseToken", file: "src/parser.ts" },
  });
});

test("keeps Unicode selectors and unusual symbol file arguments intact", () => {
  assert.deepEqual(parseArguments(["--symbol", "Über.Parser.解析", "-- generated: файл.ts"]), {
    details: false,
    query: { kind: "symbol", selector: "Über.Parser.解析", file: "-- generated: файл.ts" },
  });
});

test("rejects malformed symbol selectors", () => {
  for (const selector of ["", ".Parser", "Parser.", "Parser..parse"]) {
    assert.throws(
      () => parseArguments(["--symbol", selector, "src/parser.ts"]),
      (error: unknown) => error instanceof InvalidInputError && error.exitCode === 2,
      selector,
    );
  }
});

test("rejects unknown, repeated, misplaced, and missing flags as usage errors", () => {
  for (const argv of [
    [],
    ["--unknown"],
    ["--unknown", "src/parser.ts:42"],
    ["--details", "--details", "src/parser.ts:42"],
    ["src/parser.ts:42", "--details"],
    ["--details"],
    ["--symbol"],
    ["--symbol", "parseToken"],
    ["--symbol", "parseToken", "src/parser.ts", "extra"],
    ["--symbol", "parseToken", "src/parser.ts", "--details"],
    ["--details", "--details", "--symbol", "parseToken", "src/parser.ts"],
    ["--symbol", "parseToken", "src/parser.ts", "--symbol"],
  ]) {
    assert.throws(
      () => parseArguments(argv),
      (error: unknown) => error instanceof InvalidInputError && error.exitCode === 2,
      JSON.stringify(argv),
    );
  }
});
