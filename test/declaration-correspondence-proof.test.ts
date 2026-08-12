import assert from "node:assert/strict";
import test from "node:test";

import type { GitHunk } from "../src/provenance/model.js";
import type {
  DeclarationFact,
  DeclarationKey,
} from "../src/symbol/model.js";
import {
  proveDeclarationCorrespondence,
  type DeclarationCorrespondenceProofInput,
} from "../src/ancestry/declaration-correspondence-proof.js";

const key: DeclarationKey = {
  kind: "function",
  qualifiedName: "Parser.parseToken",
  declarationForm: "declaration",
  staticStatus: null,
};

function fact(
  overrides: Partial<DeclarationFact> = {},
): DeclarationFact {
  return {
    ...key,
    name: "parseToken",
    span: { startLine: 1, endLine: 6 },
    startOffset: 0,
    endOffset: 9999,
    ...overrides,
  };
}

function hunk(
  lines: readonly { readonly kind: "added" | "deleted" | "context"; readonly text: string }[],
  overrides: Partial<GitHunk> = {},
): GitHunk {
  return {
    basis: "derived",
    oldPath: "src/parser.ts",
    newPath: "src/parser.ts",
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 6,
    targetLineKind: "added",
    lines,
    raw: "",
    truncated: false,
    ...overrides,
  };
}

const parentLines = [
  "function parseToken(input: string): string {",
  '  const anchorOne = "parser direct parent correspondence marker alpha";',
  '  const anchorTwo = "parser direct parent correspondence marker beta";',
  "  return input.trim();",
  "}",
];

const childLines = [
  "function parseToken(input: string): string {",
  '  const anchorOne = "parser direct parent correspondence marker alpha";',
  '  const anchorTwo = "parser direct parent correspondence marker beta";',
  "  const editedLine = input.toUpperCase();",
  "  return input.trim();",
  "}",
];

const qualifyingHunk = hunk([
  { kind: "context", text: parentLines[0] as string },
  { kind: "context", text: parentLines[1] as string },
  { kind: "context", text: parentLines[2] as string },
  { kind: "added", text: childLines[3] as string },
  { kind: "context", text: parentLines[3] as string },
  { kind: "context", text: parentLines[4] as string },
]);

function input(
  overrides: Partial<DeclarationCorrespondenceProofInput> = {},
): DeclarationCorrespondenceProofInput {
  return {
    childText: childLines.join("\n"),
    parentText: parentLines.join("\n"),
    childLines,
    parentLines,
    childComplete: true,
    parentComplete: true,
    childDeclarations: [fact()],
    parentDeclarations: [fact()],
    queriedChildLine: 4,
    hunks: [qualifyingHunk],
    exactEstablished: false,
    ...overrides,
  };
}

test("proves a changed target line with a uniquely anchored same-key declaration", () => {
  const result = proveDeclarationCorrespondence(input());

  assert.equal(result.status, "transformed");
  if (result.status !== "transformed") return;
  assert.equal(result.relationship, "direct-parent-declaration");
  assert.deepEqual(result.childDeclaration.span, { startLine: 1, endLine: 6 });
  assert.deepEqual(result.parentDeclaration.span, { startLine: 1, endLine: 6 });
  assert.equal(result.anchor.distinctiveLineCount >= 2, true);
  assert.equal(result.anchor.alphanumericCount >= 40, true);
});

test("does not prove an anchor below the frozen strength floor", () => {
  const weak = [
    "function parseToken() {",
    '  const anchor = "short";',
    "  const changed = true;",
    "  return 1;",
    "}",
  ];
  const weakParent = weak.map((line, index) =>
    index === 2 ? "  const changed = false;" : line);
  const result = proveDeclarationCorrespondence(input({
    childText: weak.join("\n"),
    parentText: weakParent.join("\n"),
    childLines: weak,
    parentLines: weakParent,
    childDeclarations: [fact({ span: { startLine: 1, endLine: 5 } })],
    parentDeclarations: [fact({ span: { startLine: 1, endLine: 5 } })],
    queriedChildLine: 3,
    hunks: [hunk([
      { kind: "context", text: weak[0] as string },
      { kind: "context", text: weak[1] as string },
      { kind: "added", text: weak[2] as string },
      { kind: "context", text: weak[3] as string },
      { kind: "context", text: weak[4] as string },
    ], { oldLines: 4, newLines: 5 })],
  }));

  assert.equal(result.status, "uncertain");
  if (result.status !== "uncertain") return;
  assert.equal(result.reason, "insufficient-anchor");
});

test("rejects multiple distinct qualifying anchor alignments", () => {
  const repeated = [
    "function parseToken() {",
    '  const anchorOne = "parser repeated exact anchor alpha";',
    '  const anchorTwo = "parser repeated exact anchor beta";',
    "  const changed = true;",
    '  const anchorOne = "parser repeated exact anchor alpha";',
    '  const anchorTwo = "parser repeated exact anchor beta";',
    "}",
  ];
  const repeatedParent = repeated.map((line, index) =>
    index === 3 ? "  const changed = false;" : line);
  const result = proveDeclarationCorrespondence(input({
    childText: repeated.join("\n"),
    parentText: repeatedParent.join("\n"),
    childLines: repeated,
    parentLines: repeatedParent,
    childDeclarations: [fact({ span: { startLine: 1, endLine: 7 } })],
    parentDeclarations: [fact({ span: { startLine: 1, endLine: 7 } })],
    queriedChildLine: 4,
    hunks: [hunk([
      { kind: "context", text: repeated[0] as string },
      { kind: "context", text: repeated[1] as string },
      { kind: "context", text: repeated[2] as string },
      { kind: "added", text: repeated[3] as string },
      { kind: "context", text: repeated[4] as string },
      { kind: "context", text: repeated[5] as string },
      { kind: "context", text: repeated[6] as string },
    ], { oldLines: 6, newLines: 7 })],
  }));

  assert.equal(result.status, "uncertain");
  if (result.status !== "uncertain") return;
  assert.equal(result.reason, "ambiguous-anchor");
});

test("requires the qualifying hunk to connect both declaration regions", () => {
  const result = proveDeclarationCorrespondence(input({
    hunks: [hunk([
      { kind: "added", text: childLines[3] as string },
    ], { oldStart: 20, oldLines: 1, newStart: 4, newLines: 1 })],
  }));

  assert.equal(result.status, "uncertain");
  if (result.status !== "uncertain") return;
  assert.equal(result.reason, "disconnected-hunk");
});

test("does not accept duplicate parent keys", () => {
  const result = proveDeclarationCorrespondence(input({
    parentDeclarations: [
      fact({ span: { startLine: 1, endLine: 6 } }),
      fact({ span: { startLine: 10, endLine: 15 }, startOffset: 200, endOffset: 360 }),
    ],
  }));

  assert.equal(result.status, "uncertain");
  if (result.status !== "uncertain") return;
  assert.equal(result.reason, "ambiguous-parent-declaration");
});

for (const [label, override] of [
  ["qualified name", { qualifiedName: "Other.parseToken" }],
  ["kind", { kind: "method" as const }],
  ["declaration form", { declarationForm: "const-function" as const }],
  ["staticness", { staticStatus: true }],
] as const) {
  test("requires exact frozen key equality for changed " + label, () => {
    const result = proveDeclarationCorrespondence(input({
      parentDeclarations: [fact(override)],
    }));

    assert.equal(result.status, "uncertain");
    if (result.status !== "uncertain") return;
    assert.equal(result.reason, "no-parent-declaration");
  });
}

test("accepts an insertion-only hunk whose insertion point is inside the parent span", () => {
  const result = proveDeclarationCorrespondence(input({
    hunks: [hunk([
      { kind: "added", text: childLines[3] as string },
    ], { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1 })],
  }));

  assert.equal(result.status, "transformed");
});

test("does not treat byte-identical declarations as transformed", () => {
  const result = proveDeclarationCorrespondence(input({
    childText: parentLines.join("\n"),
    childLines: parentLines,
  }));

  assert.equal(result.status, "uncertain");
  if (result.status !== "uncertain") return;
  assert.equal(result.reason, "identical-declaration");
});

test("fails closed for incomplete material and exact ancestry", () => {
  assert.equal(proveDeclarationCorrespondence(input({ childComplete: false })).status, "unavailable");
  assert.equal(proveDeclarationCorrespondence(input({ exactEstablished: true })).status, "uncertain");
});

test("does not participate for declarations over 200 lines", () => {
  const longLines = Array.from({ length: 201 }, (_, index) => "line " + index + " with declaration context");
  const result = proveDeclarationCorrespondence(input({
    childText: longLines.join("\n"),
    parentText: longLines.join("\n") + "\nchanged",
    childLines: longLines,
    parentLines: [...longLines, "changed"],
    childDeclarations: [fact({ span: { startLine: 1, endLine: 201 }, endOffset: 9999 })],
    parentDeclarations: [fact({ span: { startLine: 1, endLine: 201 }, endOffset: 9999 })],
    queriedChildLine: 3,
  }));

  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "declaration-too-large");
});
