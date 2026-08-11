import assert from "node:assert/strict";
import test from "node:test";

import { proveExactBlock } from "../src/ancestry/exact-block-proof.js";

function input(
  currentLines: readonly string[],
  ancestorLines: readonly string[],
  currentLine: number,
  ancestorLine: number,
  overrides: { readonly currentComplete?: boolean; readonly ancestorComplete?: boolean } = {},
) {
  return {
    currentLines,
    ancestorLines,
    currentLine,
    ancestorLine,
    currentComplete: overrides.currentComplete ?? true,
    ancestorComplete: overrides.ancestorComplete ?? true,
  };
}

const block = [
  "function parseLunaToken(input: string): string {",
  "  const marker = \"distinctive-parser-marker\";",
  "  return input.trim() + marker;",
  "}",
];

test("proves an aligned exact block containing the queried line", () => {
  const proof = proveExactBlock(input(block, block, 2, 2));

  assert.deepEqual(proof, {
    basis: "derived",
    currentStartLine: 1,
    ancestorStartLine: 1,
    matchedLineCount: 4,
    distinctiveLineCount: 3,
    alphanumericCount: 94,
    comparison: "exact-lines",
  });
});

test("expands around aligned lines and reports the shifted ancestor start", () => {
  const current = ["header", ...block, "footer"];
  const ancestor = ["old header", "old context", ...block, "old footer"];
  const proof = proveExactBlock(input(current, ancestor, 4, 5));

  assert.ok(proof !== null);
  assert.equal(proof.currentStartLine, 2);
  assert.equal(proof.ancestorStartLine, 3);
  assert.equal(proof.matchedLineCount, 4);
  assert.equal(proof.currentStartLine <= 3, true);
  assert.equal(proof.ancestorStartLine <= 5, true);
});

test("rejects a nearby matching block that does not contain the queried line", () => {
  const current = [
    "function parseLunaToken(input: string): string {",
    "  const marker = \"distinctive-parser-marker\";",
    "  const queriedLineWasChanged = true;",
    "  return input.trim() + marker;",
    "}",
  ];
  const ancestor = [
    "function parseLunaToken(input: string): string {",
    "  const marker = \"distinctive-parser-marker\";",
    "  const queriedLineWasChanged = false;",
    "  return input.trim() + marker;",
    "}",
  ];

  assert.equal(proveExactBlock(input(current, ancestor, 3, 3)), null);
});

test("requires two unique distinctive exact lines", () => {
  const repeated = [
    "  return;",
    "const repeatedMarker = \"same\";",
    "const repeatedMarker = \"same\";",
    "  return;",
  ];

  assert.equal(proveExactBlock(input(repeated, repeated, 2, 2)), null);
});

test("requires at least 40 alphanumeric characters", () => {
  const short = ["const a = 1;", "const b = 2;"];

  assert.equal(proveExactBlock(input(short, short, 1, 1)), null);
});

test("rejects generic or repeated declarations even when Git reports them", () => {
  const generic = [
    "const value = 1;",
    "const value = 1;",
    "const value = 1;",
    "const value = 1;",
  ];

  assert.equal(proveExactBlock(input(generic, generic, 2, 2)), null);
});

test("rejects whitespace-only differences because comparison is exact", () => {
  const current = [...block];
  const ancestor = [block[0] as string, "const marker = \"distinctive-parser-marker\";", ...block.slice(2)];
  assert.equal(proveExactBlock(input(current, ancestor, 2, 2)), null);
});

test("rejects a partially transformed candidate block", () => {
  const current = [...block];
  const ancestor = [...block];
  ancestor[2] = "  return transform(input) + marker;";

  assert.equal(proveExactBlock(input(current, ancestor, 3, 3)), null);
});

test("fails closed when required source or object material is incomplete", () => {
  assert.equal(proveExactBlock(input(block, block, 2, 2, { currentComplete: false })), null);
  assert.equal(proveExactBlock(input(block, block, 2, 2, { ancestorComplete: false })), null);
});

test("bounds the proof context while retaining the queried line", () => {
  const current = Array.from({ length: 80 }, (_, index) =>
    index % 2 === 0
      ? `const boundedMarker${index} = \"value-${index}-with-context\";`
      : `const boundedSecond${index} = \"value-${index}-with-context\";`,
  );

  const proof = proveExactBlock(input(current, current, 40, 40));

  assert.ok(proof !== null);
  assert.equal(proof.currentStartLine <= 40, true);
  assert.equal(proof.currentStartLine + proof.matchedLineCount - 1 >= 40, true);
  assert.equal(proof.matchedLineCount <= 32, true);
});
