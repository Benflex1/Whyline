import assert from "node:assert/strict";
import test from "node:test";

import { renderSymbolDetails } from "../src/cli/render-symbol-details.js";
import { renderSymbolSummary } from "../src/cli/render-symbol-summary.js";
import type { WhylineRangeReport } from "../src/provenance/range-model.js";

test("symbol renderers expose bounded resolver context without historical claims", () => {
  const range: WhylineRangeReport = {
    repository: {
      worktreeRoot: "/repo",
      gitDir: "/repo/.git",
      commonGitDir: "/repo/.git",
      objectFormat: "sha1",
      isShallow: false,
      headCommit: "head",
      branch: "main",
      worktrees: [],
    },
    location: {
      input: "src/parser.ts:40-76",
      absolutePath: "/repo/src/parser.ts",
      repositoryPath: "src/parser.ts",
      startLine: 40,
      endLine: 76,
      lineContents: [],
      lineDigests: [],
      fileSnapshot: { size: 0, mtimeMs: 0, ino: 1, dev: 1, digest: "digest" },
      targetState: "clean",
      targetDirty: false,
    },
    lineAttributions: [],
    textualGroups: [],
    ancestry: new Map(),
    correlations: [],
    coverage: {
      committedGroups: 0,
      deepAnalyzedGroups: 0,
      readyWorktreeGroups: 0,
      workBoundGroups: 0,
      groupLimitOmissions: 0,
      uncommittedGroups: 0,
    },
  };
  const report = {
    selector: "Parser.parseToken",
    symbol: {
      language: "typescript" as const,
      dialect: "ts" as const,
      parser: "typescript" as const,
      parserVersion: "5.9.3",
      kind: "method" as const,
      name: "parseToken",
      qualifiedName: "Parser.parseToken",
      startLine: 40,
      endLine: 76,
      boundary: "declaration-covering line span" as const,
    },
    range,
  };
  const summary = renderSymbolSummary(report);
  assert.match(summary, /src\/parser\.ts — Parser\.parseToken/);
  assert.match(summary, /method, lines 40-76/);
  assert.match(summary, /Explanation/);
  assert.doesNotMatch(summary, /historical|origin/i);
  const details = renderSymbolDetails(report);
  assert.match(details, /Symbol resolution/);
  assert.match(details, /language: TypeScript/);
  assert.match(details, /dialect: ts/);
  assert.match(details, /parser: TypeScript 5\.9\.3/);
  assert.match(details, /boundary: declaration-covering line span/);
  assert.match(details, /limitation: current-worktree syntax resolution only/);
  assert.match(details, /provenance is line-granular; other text or trivia sharing the first or last resolved line is included/);
  assert.doesNotMatch(details, /\bAST\b|source excerpt|compiler diagnostic|symbol origin|same historical identity|rename occurred/i);
});
