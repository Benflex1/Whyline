import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { blameRange } from "../src/git/blame-range.js";
import { GitProcess } from "../src/git/git-process.js";
import { inspectRangeFacts } from "../src/git/inspect-range.js";
import { discoverRepositoryContext } from "../src/git/repository-context.js";
import { traceRangeGroupAncestry } from "../src/git/trace-range-ancestry.js";
import { parseLocationQuery } from "../src/location/parse-location.js";
import { resolveRangeLocation } from "../src/location/resolve-location.js";
import { groupTextualAttributions } from "../src/provenance/range-model.js";
import type { RangeTextualGroup } from "../src/provenance/range-model.js";

interface Fixture {
  readonly directory: string;
  readonly runner: GitProcess;
}

async function makeFixture(t: test.TestContext): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-range-ancestry-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const globalConfig = path.join(directory, "empty-gitconfig");
  await writeFile(globalConfig, "", "utf8");
  const runner = new GitProcess({
    environment: {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    },
  });
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "Whyline Ancestry"],
    ["config", "user.email", "ancestry@example.test"],
  ] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }
  return { directory, runner };
}

async function writeLines(fixture: Fixture, repositoryPath: string, lines: readonly string[]): Promise<void> {
  const absolutePath = path.join(fixture.directory, repositoryPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, lines.join("\n") + "\n", "utf8");
}

async function git(fixture: Fixture, args: readonly string[]): Promise<string> {
  const result = await fixture.runner.run(args, { cwd: fixture.directory });
  assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  return result.stdout.toString("utf8").trim();
}

async function inspectRange(
  fixture: Fixture,
  input: string,
): Promise<{
  readonly location: Awaited<ReturnType<typeof resolveRangeLocation>>;
  readonly repository: Awaited<ReturnType<typeof discoverRepositoryContext>>;
  readonly groups: ReturnType<typeof groupTextualAttributions>;
}> {
  const query = parseLocationQuery(input);
  assert.equal(query.kind, "range");
  if (query.kind !== "range") throw new Error("expected range query");
  const repository = await discoverRepositoryContext(fixture.runner, fixture.directory);
  const location = await resolveRangeLocation(query, repository, fixture.runner, fixture.directory);
  const facts = await blameRange(fixture.runner, repository, location.repositoryPath, location.startLine, location.endLine);
  const inspections = await inspectRangeFacts(fixture.runner, repository, location, facts);
  return {
    location,
    repository,
    groups: groupTextualAttributions(facts, inspections),
  };
}

test("reports exact coverage only for the moved queried lines", async (t) => {
  const fixture = await makeFixture(t);
  const targetPath = "src/parser.ts";
  const before = ["const beforeAlpha = \"before-alpha\";", "const beforeBeta = \"before-beta\";", "const beforeGamma = \"before-gamma\";", "const beforeDelta = \"before-delta\";"];
  const moved = [
    "const movedAlpha = \"long distinctive exact alpha parser anchor\";",
    "const movedBeta = \"long distinctive exact beta parser anchor\";",
    "const movedGamma = \"long distinctive exact gamma parser anchor\";",
    "const movedDelta = \"long distinctive exact delta parser anchor\";",
  ];
  const after = ["const afterAlpha = \"after-alpha\";", "const afterBeta = \"after-beta\";", "const afterGamma = \"after-gamma\";", "const afterDelta = \"after-delta\";"];
  await writeLines(fixture, targetPath, [...before, ...moved, ...after]);
  await git(fixture, ["add", "--", targetPath]);
  await git(fixture, ["commit", "--no-verify", "-m", "add parser block"]);
  const base = await git(fixture, ["rev-parse", "HEAD"]);
  await writeLines(fixture, targetPath, [...before, ...after, ...moved, "const refactorOnly = true;"]);
  await git(fixture, ["add", "--", targetPath]);
  await git(fixture, ["commit", "--no-verify", "-m", "move parser block"]);

  const analyzed = await inspectRange(fixture, targetPath + ":9-13");
  const group = analyzed.groups.find((value) => value.lines.some((line) => line.queryLine === 9));
  assert.ok(group);
  if (group === undefined) return;
  const coverage = await traceRangeGroupAncestry(
    fixture.runner,
    analyzed.repository,
    analyzed.location,
    group,
  );
  const exactLines = coverage.segments
    .filter((segment) => segment.status === "exact")
    .flatMap((segment) => Array.from(
      { length: segment.span.endLine - segment.span.startLine + 1 },
      (_value, index) => segment.span.startLine + index,
    ));
  assert.deepEqual(exactLines, [9, 10, 11, 12]);
  assert.equal(exactLines.includes(13), false, JSON.stringify(coverage));
  assert.equal(coverage.segments.some((segment) => segment.span.startLine === 13 && segment.status !== "exact"), true, JSON.stringify(coverage));
  assert.equal(coverage.segments.some((segment) => segment.status === "exact"
    && segment.ancestor?.commitId === base), true, JSON.stringify(coverage));
});

test("covers longer exact regions with multiple unchanged proof windows", async (t) => {
  const fixture = await makeFixture(t);
  const targetPath = "src/long.ts";
  const block = Array.from(
    { length: 40 },
    (_value, index) => "const longDistinctiveAnchor" + index + " = \"stable parser content anchor " + index + "\";",
  );
  const before = Array.from({ length: 5 }, (_value, index) => "const longBefore" + index + " = \"before\";");
  const after = Array.from({ length: 5 }, (_value, index) => "const longAfter" + index + " = \"after\";");
  await writeLines(fixture, targetPath, [...before, ...block, ...after]);
  await git(fixture, ["add", "--", targetPath]);
  await git(fixture, ["commit", "--no-verify", "-m", "add long block"]);
  const base = await git(fixture, ["rev-parse", "HEAD"]);
  await writeLines(fixture, targetPath, [...before, ...after, ...block]);
  await git(fixture, ["add", "--", targetPath]);
  await git(fixture, ["commit", "--no-verify", "-m", "move long block"]);
  const refactor = await git(fixture, ["rev-parse", "HEAD"]);
  const analyzed = await inspectRange(fixture, targetPath + ":11-50");
  const sourceGroup = analyzed.groups.find((value) => value.lines.some((line) => line.queryLine === 11));
  assert.ok(sourceGroup);
  if (sourceGroup === undefined || sourceGroup.commit === null) return;

  const group: RangeTextualGroup = {
    ...sourceGroup,
    commit: {
      ...sourceGroup.commit,
      id: refactor,
      parents: [base],
      subject: "move long block",
    },
    parent: {
      basis: "derived",
      kind: "commit",
      commitId: base,
      evidence: "sole-parent",
    },
    lines: sourceGroup.lines.map((fact) => ({
      ...fact,
      blame: {
        ...fact.blame,
        objectId: refactor,
        originalLine: fact.queryLine,
        finalLine: fact.queryLine,
      },
    })),
  };
  const coverage = await traceRangeGroupAncestry(
    fixture.runner,
    analyzed.repository,
    analyzed.location,
    group,
  );
  const exactSegments = coverage.segments.filter((segment) => segment.status === "exact");
  const exactCount = exactSegments.reduce(
    (total, segment) => total + segment.span.endLine - segment.span.startLine + 1,
    0,
  );
  assert.equal(exactCount, 40, JSON.stringify({ group, coverage }));
  assert.equal(exactSegments.length >= 2, true, JSON.stringify(coverage));
  assert.equal(exactSegments.every((segment) => (segment.proof?.matchedLineCount ?? 0) <= 32), true, JSON.stringify(coverage));
});

test("reports transformed coverage only for the qualifying changed line", async (t) => {
  const fixture = await makeFixture(t);
  const targetPath = "src/parser.ts";
  const before = Array.from({ length: 10 }, (_value, index) => "const before" + index + " = true;");
  const after = Array.from({ length: 10 }, (_value, index) => "const after" + index + " = true;");
  const declaration = [
    "function parseToken(input: string): string {",
    "  const anchorOne = \"range direct parent declaration alpha parser marker\";",
    "  const anchorTwo = \"range direct parent declaration beta parser marker\";",
    "  return input.trim();",
    "}",
  ];
  await writeLines(fixture, targetPath, [...before, ...declaration, ...after]);
  await git(fixture, ["add", "--", targetPath]);
  await git(fixture, ["commit", "--no-verify", "-m", "add range parser"]);
  await writeLines(fixture, targetPath, [
    ...before,
    declaration[0] as string,
    declaration[1] as string,
    declaration[2] as string,
    "  const editedLine = input.toUpperCase();",
    declaration[3] as string,
    declaration[4] as string,
    ...after,
  ]);
  await git(fixture, ["add", "--", targetPath]);
  await git(fixture, ["commit", "--no-verify", "-m", "move and edit range parser"]);

  const analyzed = await inspectRange(fixture, targetPath + ":11-16");
  const group = analyzed.groups.find((value) => value.lines.some((line) => line.queryLine === 14));
  assert.ok(group);
  if (group === undefined) return;
  const coverage = await traceRangeGroupAncestry(
    fixture.runner,
    analyzed.repository,
    analyzed.location,
    group,
  );
  const transformed = coverage.segments.find((segment) => segment.span.startLine === 14);
  assert.equal(transformed?.status, "transformed", JSON.stringify({ group, coverage }));
  assert.equal(transformed?.transformed?.childDeclaration.qualifiedName, "parseToken", JSON.stringify(coverage));
  assert.equal(coverage.segments.some((segment) => segment.status === "exact"), false, JSON.stringify(coverage));
});

test("bounds unique transformed declaration attempts at twelve per range invocation", async (t) => {
  const fixture = await makeFixture(t);
  const targetPath = "src/many.ts";
  const parentLines: string[] = [];
  const childLines: string[] = [];
  for (let index = 0; index < 13; index += 1) {
    parentLines.push(
      "function parseToken" + index + "(input: string): string {",
      "  const anchorOne" + index + " = \"many declaration correspondence alpha marker " + index + "\";",
      "  const anchorTwo" + index + " = \"many declaration correspondence beta marker " + index + "\";",
      "  return input.trim();",
      "}",
    );
    childLines.push(
      "function parseToken" + index + "(input: string): string {",
      "  const anchorOne" + index + " = \"many declaration correspondence alpha marker " + index + "\";",
      "  const anchorTwo" + index + " = \"many declaration correspondence beta marker " + index + "\";",
      "  const editedLine" + index + " = input.toUpperCase();",
      "  return input.trim() + editedLine" + index + ";",
      "}",
    );
  }
  await writeLines(fixture, targetPath, parentLines);
  await git(fixture, ["add", "--", targetPath]);
  await git(fixture, ["commit", "--no-verify", "-m", "add many declarations"]);
  await writeLines(fixture, targetPath, childLines);
  await git(fixture, ["add", "--", targetPath]);
  await git(fixture, ["commit", "--no-verify", "-m", "edit many declarations"]);

  const analyzed = await inspectRange(fixture, targetPath + ":1-" + childLines.length);
  const group = analyzed.groups.find((value) => value.commit?.subject === "edit many declarations");
  assert.ok(group);
  if (group === undefined) return;
  const coverage = await traceRangeGroupAncestry(
    fixture.runner,
    analyzed.repository,
    analyzed.location,
    group,
  );
  const transformedSegments = coverage.segments
    .filter((segment) => segment.status === "transformed")
  const transformedCount = transformedSegments
    .reduce((total, segment) => total + segment.span.endLine - segment.span.startLine + 1, 0);
  const transformedDeclarations = new Set(
    transformedSegments.map((segment) => segment.transformed?.childDeclaration.qualifiedName),
  );
  const workBoundCount = coverage.segments
    .filter((segment) => segment.status === "unavailable" && segment.limitations.some((value) => value.includes("12-attempt")))
    .reduce((total, segment) => total + segment.span.endLine - segment.span.startLine + 1, 0);
  assert.equal(transformedCount, 24, JSON.stringify(coverage));
  assert.equal(transformedDeclarations.size, 12, JSON.stringify(coverage));
  assert.equal(workBoundCount, 2, JSON.stringify(coverage));
});
