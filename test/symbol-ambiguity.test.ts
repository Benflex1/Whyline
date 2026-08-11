import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { CurrentSourceSnapshot } from "../src/location/resolve-location.js";
import { resolveTypeScriptSymbol } from "../src/symbol/typescript-resolver.js";
import { InvalidInputError } from "../src/whyline-error.js";

function source(repositoryPath: string, text: string): CurrentSourceSnapshot {
  return {
    absolutePath: "/repo/" + repositoryPath,
    repositoryPath,
    text,
    lines: text.split("\n").filter((_line, index, lines) => index < lines.length - 1 || !text.endsWith("\n")),
    fileSnapshot: {
      size: Buffer.byteLength(text, "utf8"),
      mtimeMs: 1,
      ino: 1,
      dev: 1,
      digest: createHash("sha256").update(text, "utf8").digest("hex"),
    },
    targetState: "clean",
    targetDirty: false,
  };
}

test("requires qualification for duplicate simple method names", async () => {
  const file = source("src/ambiguous.ts", [
    "class Parser { parse() {} }",
    "class TokenParser { parse() {} }",
  ].join("\n"));
  await assert.rejects(
    resolveTypeScriptSymbol("parse", file),
    (error: unknown) => error instanceof InvalidInputError
      && error.message.includes("symbol `parse` is ambiguous")
      && error.message.indexOf("Parser.parse") < error.message.indexOf("TokenParser.parse"),
  );
  assert.equal((await resolveTypeScriptSymbol("Parser.parse", file)).qualifiedName, "Parser.parse");
});

test("retains duplicate nested and merged declarations as ambiguity", async () => {
  const file = source("src/merged.ts", [
    "function outer() { function inner() {} }",
    "function outer() { function inner() {} }",
    "interface Merged { first: string; }",
    "interface Merged { second: string; }",
  ].join("\n"));
  for (const selector of ["outer.inner", "Merged"]) {
    await assert.rejects(
      resolveTypeScriptSymbol(selector, file),
      (error: unknown) => error instanceof InvalidInputError
        && error.message.includes("is ambiguous")
        && error.message.includes("Use an exact qualified name"),
      selector,
    );
  }
});

test("groups only compatible contiguous overload declarations", async () => {
  const functionOverloads = source("src/overloads.ts", [
    "function parse(value: string): string;",
    "function parse(value: number): number;",
    "function parse(value: string | number) { return String(value); }",
  ].join("\n"));
  const functionResult = await resolveTypeScriptSymbol("parse", functionOverloads);
  assert.equal(functionResult.startLine, 1);
  assert.equal(functionResult.endLine, 3);

  const methodOverloads = source("src/method-overloads.ts", [
    "class Parser {",
    "  parse(value: string): string;",
    "  parse(value: number): number;",
    "  parse(value: string | number) { return String(value); }",
    "}",
  ].join("\n"));
  const methodResult = await resolveTypeScriptSymbol("Parser.parse", methodOverloads);
  assert.equal(methodResult.startLine, 2);
  assert.equal(methodResult.endLine, 4);
});

test("groups all-signature ambient overload runs", async () => {
  const file = source("src/ambient.d.ts", [
    "declare function parse(value: string): string;",
    "declare function parse(value: number): number;",
  ].join("\n"));
  const result = await resolveTypeScriptSymbol("parse", file);
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 2);
});

test("does not group body-before-later or unrelated siblings", async () => {
  const file = source("src/not-grouped.ts", [
    "function bodyFirst(value: string) { return value; }",
    "function bodyFirst(value: number): number;",
    "function separated(value: string): string;",
    "const unrelated = true;",
    "function separated(value: number) { return value; }",
    "class StaticMismatch {",
    "  static parse(value: string) { return value; }",
    "  parse(value: number) { return value; }",
    "}",
  ].join("\n"));
  for (const selector of ["bodyFirst", "separated", "StaticMismatch.parse"]) {
    await assert.rejects(
      resolveTypeScriptSymbol(selector, file),
      (error: unknown) => error instanceof InvalidInputError && error.message.includes("is ambiguous"),
      selector,
    );
  }
});

test("sorts ambiguity candidates and reports the exact omitted count", async () => {
  const lines = Array.from({ length: 13 }, (_value, index) => `function duplicate${index}() {}`);
  const duplicateSource = lines.map((line) => line.replace(/duplicate\d+/, "duplicate")).join("\n");
  await assert.rejects(
    resolveTypeScriptSymbol("duplicate", source("src/many.ts", duplicateSource)),
    (error: unknown) => {
      if (!(error instanceof InvalidInputError)) return false;
      const candidateLines = error.message.split("\n").filter((line) => line.startsWith("  function"));
      return candidateLines.length === 12
        && error.message.includes("omitted 1 candidate")
        && error.message.includes("lines 1-1")
        && error.message.includes("lines 12-12");
    },
  );
});
