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
    lines: text.length === 0 ? [] : text.split("\n").filter((_line, index, values) => index < values.length - 1 || !text.endsWith("\n")),
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

test("resolves every supported TypeScript and JavaScript dialect", async () => {
  const cases = [
    ["src/parser.ts", "typescript", "ts"],
    ["src/parser.mts", "typescript", "ts"],
    ["src/parser.cts", "typescript", "ts"],
    ["src/parser.d.ts", "typescript", "ts"],
    ["src/component.tsx", "typescript", "tsx"],
    ["src/parser.js", "javascript", "js"],
    ["src/parser.mjs", "javascript", "js"],
    ["src/parser.cjs", "javascript", "js"],
    ["src/component.jsx", "javascript", "jsx"],
  ] as const;
  for (const [file, language, dialect] of cases) {
    const result = await resolveTypeScriptSymbol(
      "parseToken",
      source(file, "export function parseToken() { return 1; }\n"),
    );
    assert.equal(result.language, language, file);
    assert.equal(result.dialect, dialect, file);
    assert.equal(result.parser, "typescript", file);
    assert.equal(result.parserVersion, "5.9.3", file);
    assert.equal(result.kind, "function", file);
    assert.equal(result.name, "parseToken", file);
    assert.equal(result.qualifiedName, "parseToken", file);
    assert.equal(result.startLine, 1, file);
    assert.equal(result.endLine, 1, file);
  }
});

test("extension matching is ASCII case-insensitive", async () => {
  const result = await resolveTypeScriptSymbol(
    "parseToken",
    source("src/PARSER.TSX", "function parseToken() {}\n"),
  );
  assert.equal(result.language, "typescript");
  assert.equal(result.dialect, "tsx");
});

test("rejects unsupported language extensions before parsing", async () => {
  await assert.rejects(
    resolveTypeScriptSymbol("parseToken", source("src/component.vue", "function parseToken() {}\n")),
    (error: unknown) => error instanceof InvalidInputError
      && error.exitCode === 2
      && error.message.includes("unsupported symbol file extension"),
  );
});

test("uses syntax diagnostics across the whole current file", async () => {
  await assert.rejects(
    resolveTypeScriptSymbol(
      "parseToken",
      source("src/parser.ts", "function parseToken() {\nconst later = true;\n"),
    ),
    (error: unknown) => error instanceof InvalidInputError
      && error.exitCode === 2
      && /cannot resolve symbols because src\/parser\.ts has syntax errors/.test(error.message)
      && /first at line \d+, column \d+/.test(error.message)
      && !error.message.includes("Declaration expected"),
  );
});

test("does not resolve imports or type-check unresolved names", async () => {
  const result = await resolveTypeScriptSymbol(
    "parseToken",
    source(
      "src/parser.ts",
      "import { missing } from \"./missing\";\nexport function parseToken(value: MissingType) { return missing(value); }\n",
    ),
  );
  assert.equal(result.name, "parseToken");
});
