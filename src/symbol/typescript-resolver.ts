import path from "node:path";

import type * as ts from "typescript";

import type { CurrentSourceSnapshot } from "../location/resolve-location.js";
import { MAX_RANGE_LINES } from "../location/parse-location.js";
import { InvalidInputError, OperationalError, WhylineError } from "../whyline-error.js";
import type {
  SymbolDialect,
  SymbolKind,
  SymbolLanguage,
  SymbolResolution,
} from "./model.js";

interface DialectInfo {
  readonly language: SymbolLanguage;
  readonly dialect: SymbolDialect;
  readonly scriptKind: "ts" | "tsx" | "js" | "jsx";
}

interface Candidate {
  readonly node: ts.Node;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly parent: ts.Node;
  readonly siblingIndex: number;
  readonly declarationForm: "declaration" | "const-function";
  readonly staticStatus: boolean | null;
  readonly hasBody: boolean;
  readonly ambient: boolean;
}

interface GroupedCandidate {
  readonly first: Candidate;
  readonly last: Candidate;
}

let typescriptModulePromise: Promise<typeof import("typescript")> | undefined;

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function supportedDialectForPath(repositoryPath: string): DialectInfo {
  const lower = asciiLower(repositoryPath);
  if (lower.endsWith(".tsx")) return { language: "typescript", dialect: "tsx", scriptKind: "tsx" };
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return { language: "typescript", dialect: "ts", scriptKind: "ts" };
  }
  if (lower.endsWith(".jsx")) return { language: "javascript", dialect: "jsx", scriptKind: "jsx" };
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return { language: "javascript", dialect: "js", scriptKind: "js" };
  }
  throw new InvalidInputError("unsupported symbol file extension");
}

async function loadTypeScript(): Promise<typeof import("typescript")> {
  try {
    typescriptModulePromise ??= import("typescript");
    return await typescriptModulePromise;
  } catch {
    throw new OperationalError("TypeScript parser is unavailable");
  }
}

function hasModifier(
  typescript: typeof import("typescript"),
  node: ts.Node,
  kind: ts.SyntaxKind,
): boolean {
  if (!typescript.canHaveModifiers(node)) return false;
  return (typescript.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function childIndex(
  typescript: typeof import("typescript"),
  parent: ts.Node,
  target: ts.Node,
): number {
  let index = 0;
  let result = -1;
  typescript.forEachChild(parent, (child) => {
    if (child === target) result = index;
    index += 1;
  });
  return result;
}

function isAmbient(
  typescript: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  node: ts.Node,
): boolean {
  if (asciiLower(sourceFile.fileName).endsWith(".d.ts")) return true;
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (hasModifier(typescript, current, typescript.SyntaxKind.DeclareKeyword)) return true;
    current = current.parent;
  }
  return hasModifier(typescript, node, typescript.SyntaxKind.DeclareKeyword);
}

function declarationName(
  typescript: typeof import("typescript"),
  node: ts.Node,
): string | undefined {
  if (
    typescript.isFunctionDeclaration(node)
    || typescript.isClassDeclaration(node)
    || typescript.isInterfaceDeclaration(node)
    || typescript.isTypeAliasDeclaration(node)
    || typescript.isEnumDeclaration(node)
  ) {
    return node.name === undefined ? undefined : node.name.text;
  }
  if (typescript.isMethodDeclaration(node)) {
    return typescript.isIdentifier(node.name) ? node.name.text : undefined;
  }
  if (typescript.isConstructorDeclaration(node)) return "constructor";
  return undefined;
}

function isClassDeclarationParent(typescript: typeof import("typescript"), node: ts.Node): boolean {
  return typescript.isClassDeclaration(node.parent);
}

function isPrivateMethod(
  typescript: typeof import("typescript"),
  node: ts.MethodDeclaration,
): boolean {
  return typescript.isPrivateIdentifier(node.name)
    || hasModifier(typescript, node, typescript.SyntaxKind.PrivateKeyword);
}

function staticStatus(
  typescript: typeof import("typescript"),
  node: ts.Node,
): boolean | null {
  if (!typescript.isMethodDeclaration(node)) return null;
  return hasModifier(typescript, node, typescript.SyntaxKind.StaticKeyword);
}

function candidateForNode(
  typescript: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  node: ts.Node,
  enclosingNames: readonly string[],
): Candidate | undefined {
  let kind: SymbolKind | undefined;
  let name: string | undefined;
  let declarationForm: Candidate["declarationForm"] = "declaration";
  let hasBody = false;
  let staticValue: boolean | null = null;

  if (typescript.isFunctionDeclaration(node)) {
    kind = "function";
    name = declarationName(typescript, node);
    hasBody = node.body !== undefined;
  } else if (typescript.isClassDeclaration(node)) {
    kind = "class";
    name = declarationName(typescript, node);
    hasBody = true;
  } else if (typescript.isInterfaceDeclaration(node)) {
    kind = "interface";
    name = declarationName(typescript, node);
  } else if (typescript.isTypeAliasDeclaration(node)) {
    kind = "type";
    name = declarationName(typescript, node);
  } else if (typescript.isEnumDeclaration(node)) {
    kind = "enum";
    name = declarationName(typescript, node);
    hasBody = true;
  } else if (typescript.isConstructorDeclaration(node)) {
    if (!isClassDeclarationParent(typescript, node)) return undefined;
    kind = "constructor";
    name = "constructor";
    hasBody = node.body !== undefined;
  } else if (typescript.isMethodDeclaration(node)) {
    if (!isClassDeclarationParent(typescript, node) || isPrivateMethod(typescript, node)) return undefined;
    kind = "method";
    name = declarationName(typescript, node);
    hasBody = node.body !== undefined;
    staticValue = staticStatus(typescript, node);
  } else if (typescript.isVariableStatement(node)) {
    if ((node.declarationList.flags & typescript.NodeFlags.Const) === 0) return undefined;
    if (node.declarationList.declarations.length !== 1) return undefined;
    const declaration = node.declarationList.declarations[0];
    if (
      declaration === undefined
      || !typescript.isIdentifier(declaration.name)
      || declaration.initializer === undefined
      || (!typescript.isArrowFunction(declaration.initializer)
        && !typescript.isFunctionExpression(declaration.initializer))
    ) return undefined;
    kind = "function";
    name = declaration.name.text;
    declarationForm = "const-function";
    hasBody = true;
  }

  if (kind === undefined || name === undefined || name.length === 0) return undefined;
  const parent = node.parent;
  return {
    node,
    kind,
    name,
    qualifiedName: [...enclosingNames, name].join("."),
    parent,
    siblingIndex: childIndex(typescript, parent, node),
    declarationForm,
    staticStatus: staticValue,
    hasBody,
    ambient: isAmbient(typescript, sourceFile, node),
  };
}

function collectCandidates(
  typescript: typeof import("typescript"),
  sourceFile: ts.SourceFile,
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  const visit = (node: ts.Node, enclosingNames: readonly string[]): void => {
    if (typescript.isModuleDeclaration(node) || typescript.isClassExpression(node)) return;
    const candidate = candidateForNode(typescript, sourceFile, node, enclosingNames);
    if (candidate !== undefined) candidates.push(candidate);
    const nextNames = candidate === undefined
      ? enclosingNames
      : [...enclosingNames, candidate.name];
    typescript.forEachChild(node, (child) => visit(child, nextNames));
  };
  visit(sourceFile, []);
  return candidates;
}

function overloadable(kind: SymbolKind): boolean {
  return kind === "function" || kind === "method" || kind === "constructor";
}

function compatibleForOverload(left: Candidate, right: Candidate): boolean {
  return overloadable(left.kind)
    && left.kind === right.kind
    && left.name === right.name
    && left.qualifiedName === right.qualifiedName
    && left.parent === right.parent
    && left.staticStatus === right.staticStatus
    && left.declarationForm === right.declarationForm
    && left.ambient === right.ambient;
}

function groupCandidates(candidates: readonly Candidate[]): readonly GroupedCandidate[] {
  const byParent = new Map<ts.Node, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = byParent.get(candidate.parent);
    if (bucket === undefined) byParent.set(candidate.parent, [candidate]);
    else bucket.push(candidate);
  }

  const grouped: GroupedCandidate[] = [];
  for (const bucket of byParent.values()) {
    bucket.sort((left, right) => left.siblingIndex - right.siblingIndex);
    let index = 0;
    while (index < bucket.length) {
      const first = bucket[index];
      if (first === undefined) break;
      const run = [first];
      let cursor = index + 1;
      while (cursor < bucket.length) {
        const previous = run[run.length - 1];
        const next = bucket[cursor];
        if (previous === undefined || next === undefined) break;
        if (next.siblingIndex !== previous.siblingIndex + 1 || !compatibleForOverload(first, next)) break;
        if (previous.hasBody) break;
        run.push(next);
        cursor += 1;
        if (next.hasBody) break;
      }

      const canGroup = run.length > 1
        && (run.some((candidate) => candidate.hasBody) || first.ambient);
      if (canGroup) {
        grouped.push({ first: run[0] as Candidate, last: run[run.length - 1] as Candidate });
      } else {
        for (const candidate of run) grouped.push({ first: candidate, last: candidate });
      }
      index += run.length;
    }
  }
  return grouped;
}

function lineNumber(
  sourceFile: ts.SourceFile,
  position: number,
): number {
  const bounded = Math.max(0, Math.min(position, sourceFile.text.length));
  return sourceFile.getLineAndCharacterOfPosition(bounded).line + 1;
}

function toResolution(
  typescript: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  info: DialectInfo,
  candidate: GroupedCandidate,
): SymbolResolution {
  const start = candidate.first.node.getStart(sourceFile, false);
  const end = Math.max(start + 1, candidate.last.node.end);
  const endPosition = Math.max(start, end - 1);
  return {
    language: info.language,
    dialect: info.dialect,
    parser: "typescript",
    parserVersion: typescript.version,
    kind: candidate.first.kind,
    name: candidate.first.name,
    qualifiedName: candidate.first.qualifiedName,
    startLine: lineNumber(sourceFile, start),
    endLine: lineNumber(sourceFile, endPosition),
    boundary: "complete declaration",
    ...(candidate.first.declarationForm === "const-function" ? { declarationForm: "const-function" } : {}),
  };
}

function ambiguityMessage(
  selector: string,
  repositoryPath: string,
  matches: readonly SymbolResolution[],
): string {
  const shown = matches.slice(0, 12);
  const lines = shown.map((candidate) =>
    `  ${candidate.kind}  ${candidate.qualifiedName}  lines ${candidate.startLine}-${candidate.endLine}`);
  const omitted = matches.length - shown.length;
  if (omitted > 0) lines.push(`  … omitted ${omitted} candidate${omitted === 1 ? "" : "s"}`);
  lines.push("", "Use an exact qualified name where available; otherwise query one of the shown ranges.");
  return `symbol \`${selector}\` is ambiguous in ${repositoryPath}\n\nCandidates:\n${lines.join("\n")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectSymbol(
  selector: string,
  repositoryPath: string,
  resolutions: readonly SymbolResolution[],
): SymbolResolution {
  const matches = resolutions
    .filter((candidate) => selector.includes(".")
      ? candidate.qualifiedName === selector
      : candidate.name === selector)
    .sort((left, right) => left.startLine - right.startLine
      || left.endLine - right.endLine
      || compareText(left.kind, right.kind)
      || compareText(left.qualifiedName, right.qualifiedName));
  if (matches.length === 0) {
    throw new InvalidInputError(`symbol \`${selector}\` was not found in ${repositoryPath}`);
  }
  if (matches.length > 1) {
    throw new InvalidInputError(ambiguityMessage(selector, repositoryPath, matches));
  }
  return matches[0] as SymbolResolution;
}

function compilerScriptKind(
  typescript: typeof import("typescript"),
  scriptKind: DialectInfo["scriptKind"],
): ts.ScriptKind {
  switch (scriptKind) {
    case "tsx": return typescript.ScriptKind.TSX;
    case "js": return typescript.ScriptKind.JS;
    case "jsx": return typescript.ScriptKind.JSX;
    case "ts": return typescript.ScriptKind.TS;
  }
}

function parseProgram(
  typescript: typeof import("typescript"),
  source: CurrentSourceSnapshot,
  info: DialectInfo,
): { readonly program: ts.Program; readonly sourceFile: ts.SourceFile } {
  const fileName = source.absolutePath;
  const compilerOptions: ts.CompilerOptions = {
    allowJs: info.language === "javascript",
    checkJs: false,
    module: typescript.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: typescript.ScriptTarget.ESNext,
  };
  if (info.dialect === "tsx" || info.dialect === "jsx") {
    compilerOptions.jsx = typescript.JsxEmit.Preserve;
  }
  const sourceFile = typescript.createSourceFile(
    fileName,
    source.text,
    typescript.ScriptTarget.Latest,
    true,
    compilerScriptKind(typescript, info.scriptKind),
  );
  const defaultHost = typescript.createCompilerHost(compilerOptions, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    directoryExists: (directory) => directory === path.dirname(fileName),
    fileExists: (requested) => requested === fileName,
    getCurrentDirectory: () => path.dirname(fileName),
    getDefaultLibFileName: () => "",
    getDirectories: () => [],
    getSourceFile: (requested, _languageVersion, _onError, _shouldCreateNewSourceFile) =>
      requested === fileName ? sourceFile : undefined,
    getSourceFileByPath: (requested) => requested === fileName ? sourceFile : undefined,
    readDirectory: () => [],
    readFile: (requested) => requested === fileName ? source.text : undefined,
    realpath: (requested) => requested,
    resolveModuleNames: (moduleNames) => moduleNames.map(() => undefined),
    resolveModuleNameLiterals: (moduleLiterals) => moduleLiterals.map(() => ({ resolvedModule: undefined })),
    writeFile: () => undefined,
  };
  return { program: typescript.createProgram([fileName], compilerOptions, host), sourceFile };
}

function syntaxCheck(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  source: CurrentSourceSnapshot,
): void {
  const diagnostics = [...program.getSyntacticDiagnostics(sourceFile)]
    .sort((left, right) => (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER));
  const first = diagnostics[0];
  if (first === undefined) return;
  const start = Math.max(0, Math.min(first.start ?? 0, sourceFile.text.length));
  const location = sourceFile.getLineAndCharacterOfPosition(start);
  throw new InvalidInputError(
    `cannot resolve symbols because ${source.repositoryPath} has syntax errors (first at line ${location.line + 1}, column ${location.character + 1})`,
  );
}

export async function resolveTypeScriptSymbol(
  selector: string,
  source: CurrentSourceSnapshot,
): Promise<SymbolResolution> {
  const selectorParts = selector.split(".");
  if (selector.length === 0 || selectorParts.some((part) => part.length === 0)) {
    throw new InvalidInputError("symbol selector must contain non-empty dot-separated components");
  }
  const info = supportedDialectForPath(source.repositoryPath);
  const typescript = await loadTypeScript();
  try {
    const parsed = parseProgram(typescript, source, info);
    syntaxCheck(parsed.program, parsed.sourceFile, source);
    const candidates = groupCandidates(collectCandidates(typescript, parsed.sourceFile));
    const resolutions = candidates.map((candidate) => toResolution(typescript, parsed.sourceFile, info, candidate));
    const selected = selectSymbol(selector, source.repositoryPath, resolutions);
    const span = selected.endLine - selected.startLine + 1;
    if (span > MAX_RANGE_LINES) {
      throw new InvalidInputError(
        `symbol \`${selector}\` spans ${span} lines (${selected.startLine}-${selected.endLine}); the current limit is ${MAX_RANGE_LINES} lines`,
      );
    }
    return selected;
  } catch (error: unknown) {
    if (error instanceof WhylineError) throw error;
    throw new OperationalError("TypeScript parser failed while resolving symbols");
  }
}
