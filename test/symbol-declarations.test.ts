import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { CurrentSourceSnapshot } from "../src/location/resolve-location.js";
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

test("resolves declarations with complete AST boundaries", async () => {
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
