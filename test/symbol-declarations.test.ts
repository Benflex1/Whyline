import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { CurrentSourceSnapshot } from "../src/location/resolve-location.js";
import { parseDeclarationIndex } from "../src/symbol/declaration-index.js";
import { resolveTypeScriptSymbol } from "../src/symbol/typescript-resolver.js";

function source(repositoryPath: string, text: string): CurrentSourceSnapshot {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return {
    absolutePath: "/repo/" + repositoryPath,
    repositoryPath,
    text,
    lines,
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

test("resolves declarations to declaration-covering line spans", async () => {
  const file = source("src/parser.ts", [
    "/** function docs are leading trivia */",
    "export function topParse<T>(value: T) {",
    "  // physically inside the function",
    "  return value;",
    "}",
    "",
    "/** class docs are leading trivia */",
    "@sealed",
    "export default class Parser<T> {",
    "  /** method docs are leading trivia */",
    "  @logged",
    "  public parseToken<U>(value: U) {",
    "    return value;",
    "  }",
    "  // trailing method comment",
    "  constructor(value: T) {",
    "    void value;",
    "  }",
    "}",
    "// trailing class comment",
    "",
    "export interface Token { value: string; }",
    "export type TokenId = string;",
    "export enum TokenKind { Text, End }",
    "const constFunction = (value: string) => value;",
    "const expressionFunction = function internalName(value: string) { return value; };",
  ].join("\n"));

  const functionResult = await resolveTypeScriptSymbol("topParse", file);
  assert.equal(functionResult.kind, "function");
  assert.equal(functionResult.startLine, 2);
  assert.equal(functionResult.endLine, 5);

  const defaultFunction = await resolveTypeScriptSymbol(
    "parseToken",
    source("src/default.ts", "export default function parseToken() { return true; }\n"),
  );
  assert.equal(defaultFunction.kind, "function");
  assert.equal(defaultFunction.startLine, 1);

  const parser = await resolveTypeScriptSymbol("Parser", file);
  assert.equal(parser.kind, "class");
  assert.equal(parser.startLine, 8);
  assert.equal(parser.endLine, 19);

  const method = await resolveTypeScriptSymbol("Parser.parseToken", file);
  assert.equal(method.kind, "method");
  assert.equal(method.startLine, 11);
  assert.equal(method.endLine, 14);

  const constructor = await resolveTypeScriptSymbol("Parser.constructor", file);
  assert.equal(constructor.kind, "constructor");
  assert.equal(constructor.startLine, 16);
  assert.equal(constructor.endLine, 18);

  assert.equal((await resolveTypeScriptSymbol("Token", file)).kind, "interface");
  assert.equal((await resolveTypeScriptSymbol("TokenId", file)).kind, "type");
  assert.equal((await resolveTypeScriptSymbol("TokenKind", file)).kind, "enum");
  assert.equal((await resolveTypeScriptSymbol("constFunction", file)).kind, "function");
  assert.equal((await resolveTypeScriptSymbol("expressionFunction", file)).name, "expressionFunction");
});

test("supports nested qualification and Unicode identifiers", async () => {
  const file = source("src/unicode.ts", [
    "function outer() {",
    "  function inner() {",
    "    function decode() {}",
    "  }",
    "}",
    "class Parser {",
    "  parseToken() {",
    "    function decode() {}",
    "  }",
    "}",
    "function 解析() {}",
    "class ÜParser { method() {} }",
  ].join("\n"));
  assert.equal((await resolveTypeScriptSymbol("outer.inner", file)).qualifiedName, "outer.inner");
  assert.equal((await resolveTypeScriptSymbol("outer.inner.decode", file)).qualifiedName, "outer.inner.decode");
  assert.equal((await resolveTypeScriptSymbol("Parser.parseToken.decode", file)).qualifiedName, "Parser.parseToken.decode");
  assert.equal((await resolveTypeScriptSymbol("解析", file)).name, "解析");
  assert.equal((await resolveTypeScriptSymbol("ÜParser.method", file)).qualifiedName, "ÜParser.method");
});

test("preserves declarations across BOM, CRLF, and missing final newline", async () => {
  const file = source("src/crlf.ts", "\uFEFF/** docs */\r\nexport function parseToken() {\r\n  return true;\r\n}");
  const result = await resolveTypeScriptSymbol("parseToken", file);
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 4);
});

test("projects same-line leading and trailing material to one declaration-covering line span", async () => {
  const result = await resolveTypeScriptSymbol(
    "parseToken",
    source("src/inline.ts", "/** docs */ function parseToken() {} // trailing\n"),
  );
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 1);
});

test("selects the queried declaration while retaining its shared line span", async () => {
  const result = await resolveTypeScriptSymbol(
    "first",
    source("src/shared-line.ts", "function first() {} function second() {}\n"),
  );
  assert.equal(result.name, "first");
  assert.equal(result.qualifiedName, "first");
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 1);
});

test("excludes trivia on separate lines from the declaration-covering line span", async () => {
  const result = await resolveTypeScriptSymbol(
    "parseToken",
    source("src/separate-trivia.ts", "/** docs */\nfunction parseToken() {}\n// trailing\n"),
  );
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 2);
});

test("does not reinterpret unsupported declaration forms", async () => {
  const file = source("src/unsupported.ts", [
    "export default function () {}",
    "export default class {}",
    "let letFunction = () => {};",
    "var varFunction = function () {};",
    "const first = () => {}, second = () => {};",
    "const { destructured } = { destructured: () => {} };",
    "const object = { objectMethod() {}, property: 1 };",
    "class Example {",
    "  get value() { return 1; }",
    "  set value(value: number) {}",
    "  field = () => {};",
    "  #privateMethod() {}",
    "  [computed]() {}",
    "  \"stringMethod\"() {}",
    "  1() {}",
    "}",
    "interface Members { member(): void; (value: string): void; }",
    "enum MembersEnum { Member }",
    "const nonFunction = 1;",
    "label: for (const value of []) { break label; }",
    "const classExpression = class { method() {} };",
    "namespace Hidden { export function hidden() {} }",
  ].join("\n"));
  for (const selector of [
    "default",
    "letFunction",
    "varFunction",
    "first",
    "second",
    "destructured",
    "objectMethod",
    "Example.value",
    "Example.field",
    "Example.privateMethod",
    "Example.computed",
    "Example.stringMethod",
    "Example.1",
    "Members.member",
    "MembersEnum.Member",
    "nonFunction",
    "label",
    "classExpression",
    "Example.method",
    "hidden",
    "Hidden.hidden",
  ]) {
    await assert.rejects(
      resolveTypeScriptSymbol(selector, file),
      (error: unknown) => error instanceof Error && /not found|syntax errors/.test(error.message),
      selector,
    );
  }
});

test("parses historical TypeScript-family text into reusable declaration facts", async () => {
  for (const [repositoryPath, expectedDialect] of [
    ["src/history.ts", "ts"],
    ["src/history.tsx", "tsx"],
    ["src/history.js", "js"],
    ["src/history.jsx", "jsx"],
  ] as const) {
    const index = await parseDeclarationIndex(
      repositoryPath,
      "class Parser { parseToken() { return 1; } }\nfunction 解析() {}\n",
    );
    assert.equal(index.dialect, expectedDialect, repositoryPath);
    assert.ok(index.declarations.some((declaration) => declaration.qualifiedName === "Parser.parseToken"));
    assert.ok(index.declarations.some((declaration) => declaration.qualifiedName === "解析"));
    assert.equal(index.declarations.some((declaration) => "node" in declaration), false);
  }
});

test("historical declaration parsing retains duplicate keys without selecting one", async () => {
  const index = await parseDeclarationIndex(
    "src/history.ts",
    "function parseToken() {}\nfunction parseToken() {}\n",
  );
  assert.equal(index.declarations.filter((declaration) => declaration.qualifiedName === "parseToken").length, 2);
});

test("historical declaration syntax errors are rejected without recovered facts", async () => {
  await assert.rejects(
    parseDeclarationIndex("src/history.ts", "function parseToken() {\nconst broken = ;\n"),
    (error: unknown) => error instanceof Error && /syntax errors/.test(error.message),
  );
});

test("historical declaration facts are bounded at 512 supported declarations", async () => {
  const sourceText = Array.from({ length: 513 }, (_value, index) => `function parseToken${index}() {}`).join("\n");
  await assert.rejects(
    parseDeclarationIndex("src/history.ts", sourceText, { maxDeclarations: 512 }),
    (error: unknown) => error instanceof Error && /512/.test(error.message),
  );
});
