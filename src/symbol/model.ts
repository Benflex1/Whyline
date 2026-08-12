export type SymbolLanguage = "typescript" | "javascript";

export type SymbolDialect = "ts" | "tsx" | "js" | "jsx";

export type SymbolKind =
  | "function"
  | "method"
  | "constructor"
  | "class"
  | "interface"
  | "type"
  | "enum";

export interface SymbolResolution {
  readonly language: SymbolLanguage;
  readonly dialect: SymbolDialect;
  readonly parser: "typescript";
  readonly parserVersion: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly boundary: "declaration-covering line span";
  readonly declarationForm?: "const-function";
}
