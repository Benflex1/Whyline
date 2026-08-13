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

export interface DeclarationSpan {
  readonly startLine: number;
  readonly endLine: number;
}

export type DeclarationForm = "declaration" | "const-function";

export interface DeclarationKey {
  readonly kind: SymbolKind;
  readonly qualifiedName: string;
  readonly declarationForm: DeclarationForm;
  readonly staticStatus: boolean | null;
}

export interface DeclarationFact extends DeclarationKey {
  readonly name: string;
  readonly span: DeclarationSpan;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface DeclarationIndex {
  readonly language: SymbolLanguage;
  readonly dialect: SymbolDialect;
  readonly parser: "typescript";
  readonly parserVersion: string;
  readonly declarations: readonly DeclarationFact[];
}

export interface DeclarationDescriptor extends DeclarationKey {
  readonly span: DeclarationSpan;
}

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
