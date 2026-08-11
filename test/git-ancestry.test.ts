import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitProcess, type GitRunner } from "../src/git/git-process.js";
import { traceLineAncestry } from "../src/git/trace-line-ancestry.js";
import { analyzeLocation } from "../src/provenance/explain-location.js";
import type { WhylineReport } from "../src/provenance/model.js";
import { OperationalError } from "../src/whyline-error.js";

const BLOCK = [
  "function parseTokenWithDistinctiveContext(input: string): string {",
  "  const parserAnchor = \"exact-ancestor-parser-anchor\";",
  "  const secondaryAnchor = \"second-exact-parser-anchor\";",
  "  return `${input}:${parserAnchor}:${secondaryAnchor}`;",
  "}",
];

const MOVED_BLOCK = [
  "const movedParserAnchor = \"long exact same-file parser movement anchor\";",
  "const movedParserSecond = \"second long exact parser movement anchor\";",
];
const BEFORE_CONTEXT = Array.from({ length: 10 }, (_, index) => `const beforeContext${index} = \"before-${index}\";`);
const AFTER_CONTEXT = Array.from({ length: 10 }, (_, index) => `const afterContext${index} = \"after-${index}\";`);

interface Fixture {
  readonly directory: string;
  readonly codexHome: string;
  readonly globalConfig: string;
  readonly runner: GitProcess;
}

async function git(
  fixture: Pick<Fixture, "directory" | "runner">,
  args: readonly string[],
): Promise<Buffer> {
  const result = await fixture.runner.run(args, { cwd: fixture.directory });
  assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  return result.stdout;
}

async function fixture(t: test.TestContext, objectFormat?: "sha1" | "sha256"): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-ancestry-test-"));
  const globalConfig = path.join(directory, "empty-gitconfig");
  const codexHome = path.join(directory, "codex-home");
  await writeFile(globalConfig, "", "utf8");
  await mkdir(codexHome, { recursive: true });
  const runner = new GitProcess({
    environment: {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
      CODEX_HOME: codexHome,
    },
  });
  const initArgs = ["init", "--initial-branch=main"];
  if (objectFormat === "sha256") initArgs.push("--object-format=sha256");
  const initialized = await runner.run(initArgs, { cwd: directory });
  if (initialized.exitCode !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(initialized.stderr.toString("utf8"));
  }
  await git({ directory, runner }, ["config", "user.name", "Whyline Ancestry"]);
  await git({ directory, runner }, ["config", "user.email", "ancestry@example.test"]);
  await git({ directory, runner }, ["config", "commit.gpgSign", "false"]);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, codexHome, globalConfig, runner };
}

async function writeFixtureFile(
  directory: string,
  repositoryPath: string,
  lines: readonly string[],
): Promise<void> {
  const filePath = path.join(directory, repositoryPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function commitFixture(
  fixtureValue: Fixture,
  repositoryPaths: readonly string[],
  message: string,
): Promise<string> {
  await git(fixtureValue, ["add", "--", ...repositoryPaths]);
  await git(fixtureValue, ["commit", "--no-verify", "-m", message]);
  return (await git(fixtureValue, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

async function analyze(
  fixtureValue: Fixture,
  repositoryPath: string,
  line: number,
): Promise<WhylineReport> {
  return analyzeLocation(`${repositoryPath}:${line}`, {
    currentDirectory: fixtureValue.directory,
    git: fixtureValue.runner,
    codexHome: fixtureValue.codexHome,
  });
}

async function ancestry(
  fixtureValue: Fixture,
  report: WhylineReport,
) {
  return traceLineAncestry(
    fixtureValue.runner,
    report.repository,
    report.location,
    report.provenance,
  );
}

test("same-file movement proves a proper older exact ancestor and anchors the query", async (t) => {
  const f = await fixture(t);
  const basePath = "src/parser.ts";
  await writeFixtureFile(f.directory, basePath, [...BEFORE_CONTEXT, ...MOVED_BLOCK, ...AFTER_CONTEXT]);
  const base = await commitFixture(f, [basePath], "add parser block");
  await writeFixtureFile(f.directory, basePath, [
    ...BEFORE_CONTEXT,
    ...AFTER_CONTEXT,
    ...MOVED_BLOCK,
  ]);
  const refactor = await commitFixture(f, [basePath], "refactor: move parser block");

  const report = await analyze(f, basePath, 22);
  assert.equal(report.provenance.commit?.id, refactor, JSON.stringify(report.provenance.blame));
  const result = await ancestry(f, report);

  assert.equal(result.status, "exact");
  if (result.status !== "exact") return;
  assert.equal(result.relationship, "exact-ancestor");
  assert.equal(result.transition, "same-file-move");
  assert.equal(result.ancestor.commitId, base);
  assert.equal(result.ancestor.path, basePath);
  assert.equal(result.ancestor.line, 12);
  assert.equal(result.proof.currentStartLine <= report.location.requestedLine, true);
  assert.equal(result.proof.currentStartLine + result.proof.matchedLineCount - 1 >= report.location.requestedLine, true);
  assert.equal(result.proof.distinctiveLineCount >= 2, true);
  assert.equal(result.proof.alphanumericCount >= 40, true);
});

test("cross-file movement is reported only as combined move-or-copy", async (t) => {
  const f = await fixture(t);
  const sourcePath = "src/legacy-parser.ts";
  const targetPath = "src/parser.ts";
  await writeFixtureFile(f.directory, sourcePath, MOVED_BLOCK);
  await writeFixtureFile(f.directory, targetPath, ["const targetHeader = true;"]);
  const base = await commitFixture(f, [sourcePath, targetPath], "add legacy parser");
  await writeFixtureFile(f.directory, targetPath, ["const targetHeader = true;", ...MOVED_BLOCK]);
  await rm(path.join(f.directory, sourcePath));
  const refactor = await commitFixture(f, [sourcePath, targetPath], "refactor: move parser file");

  const report = await analyze(f, targetPath, 2);
  assert.equal(report.provenance.commit?.id, refactor);
  const result = await ancestry(f, report);

  assert.equal(result.status, "exact");
  if (result.status !== "exact") return;
  assert.equal(result.transition, "cross-file-move-or-copy");
  assert.equal(result.ancestor.commitId, base);
  assert.equal(result.ancestor.path, sourcePath);
});

test("connected rename evidence takes precedence over generic cross-file classification", async (t) => {
  const f = await fixture(t);
  const sourcePath = "src/before-parser.ts";
  const targetPath = "src/after-parser.ts";
  await writeFixtureFile(f.directory, sourcePath, [...BEFORE_CONTEXT, ...MOVED_BLOCK, ...AFTER_CONTEXT]);
  const base = await commitFixture(f, [sourcePath], "add rename source");
  await git(f, ["mv", "--", sourcePath, targetPath]);
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...AFTER_CONTEXT, ...MOVED_BLOCK]);
  await git(f, ["add", "-A"]);
  await git(f, ["commit", "--no-verify", "-m", "refactor: rename parser path"]);
  const rename = (await git(f, ["rev-parse", "HEAD"])).toString("utf8").trim();

  const report = await analyze(f, targetPath, 22);
  assert.equal(report.provenance.commit?.id, rename);
  assert.ok(report.provenance.changedPaths.some((change) =>
    change.kind === "renamed" && change.oldPath === sourcePath && change.newPath === targetPath));
  const result = await ancestry(f, report);

  assert.equal(result.status, "exact");
  if (result.status !== "exact") return;
  assert.equal(result.transition, "renamed-path");
  assert.equal(result.ancestor.commitId, base);
  assert.equal(result.ancestor.path, sourcePath);
});

test("root attribution stops at the visible root instead of claiming origin", async (t) => {
  const f = await fixture(t);
  const targetPath = "src/root.ts";
  await writeFixtureFile(f.directory, targetPath, BLOCK);
  const root = await commitFixture(f, [targetPath], "root parser");

  const report = await analyze(f, targetPath, 2);
  assert.equal(report.provenance.commit?.id, root);
  assert.deepEqual(await ancestry(f, report), {
    status: "none",
    reason: "root-history-boundary",
    limitations: ["The textual attribution is the visible history root; no semantic origin was inferred."],
  });
});

test("no older movement candidate remains typed none", async (t) => {
  const f = await fixture(t);
  const targetPath = "src/unchanged.ts";
  await writeFixtureFile(f.directory, "README.md", ["history anchor"]);
  await commitFixture(f, ["README.md"], "establish history");
  await writeFixtureFile(f.directory, targetPath, BLOCK);
  const target = await commitFixture(f, [targetPath], "add unchanged parser");

  const report = await analyze(f, targetPath, 2);
  assert.equal(report.provenance.commit?.id, target);
  const result = await ancestry(f, report);
  assert.equal(result.status, "none");
  if (result.status !== "none") return;
  assert.equal(result.reason, "no-earlier-move-copy-attribution");
});

test("generic repeated context and transformed candidates never become exact", async (t) => {
  const f = await fixture(t);
  const genericPath = "src/generic.ts";
  const repeated = [
    "const sharedValue = \"generic repeated declaration with a long anchor\";",
    "const sharedValue = \"generic repeated declaration with a long anchor\";",
  ];
  await writeFixtureFile(f.directory, genericPath, [...BEFORE_CONTEXT, ...repeated, ...AFTER_CONTEXT]);
  await commitFixture(f, [genericPath], "add generic declarations");
  await writeFixtureFile(f.directory, genericPath, [...BEFORE_CONTEXT, ...AFTER_CONTEXT, ...repeated]);
  const genericCommit = await commitFixture(f, [genericPath], "refactor: move generic declarations");
  const genericReport = await analyze(f, genericPath, 22);
  assert.equal(genericReport.provenance.commit?.id, genericCommit);
  assert.notEqual((await ancestry(f, genericReport)).status, "exact");

  const transformedPath = "src/transformed.ts";
  await writeFixtureFile(f.directory, transformedPath, MOVED_BLOCK);
  await commitFixture(f, [transformedPath], "add transform source");
  await writeFixtureFile(f.directory, transformedPath, [
    "const movedAbove = true;",
    MOVED_BLOCK[0] as string,
    "const movedParserSecond = \"transformed-anchor\";",
  ]);
  const transformedCommit = await commitFixture(f, [transformedPath], "refactor: partially transform parser");
  const transformedReport = await analyze(f, transformedPath, 3);
  assert.equal(transformedReport.provenance.commit?.id, transformedCommit);
  assert.notEqual((await ancestry(f, transformedReport)).status, "exact");
});

test("ambiguous parent selection is unavailable without inventing a merge parent", async (t) => {
  const f = await fixture(t);
  const targetPath = "src/merge.ts";
  await writeFixtureFile(f.directory, targetPath, BLOCK);
  await commitFixture(f, [targetPath], "merge fixture");
  const report = await analyze(f, targetPath, 2);
  const result = await traceLineAncestry(f.runner, report.repository, report.location, {
    ...report.provenance,
    parent: { basis: "derived", kind: "ambiguous", parentIds: ["parent-a", "parent-b"] },
  });

  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "ambiguous-parent");
});

test("read-only ancestry commands remain argv-safe for Unicode paths", async (t) => {
  const f = await fixture(t);
  const sourcePath = "src/λ-legacy.ts";
  const targetPath = "src/λ-current.ts";
  await writeFixtureFile(f.directory, sourcePath, MOVED_BLOCK);
  await writeFixtureFile(f.directory, targetPath, ["const unicodeTarget = true;"]);
  await commitFixture(f, [sourcePath, targetPath], "add unicode source");
  await writeFixtureFile(f.directory, targetPath, ["const unicodeTarget = true;", ...MOVED_BLOCK]);
  await rm(path.join(f.directory, sourcePath));
  await commitFixture(f, [sourcePath, targetPath], "move unicode source");

  const calls: string[][] = [];
  const recordingRunner: GitRunner = {
    run: (args, options) => {
      calls.push([...args]);
      return f.runner.run(args, options);
    },
  };
  const report = await analyzeLocation(`${targetPath}:2`, {
    currentDirectory: f.directory,
    git: recordingRunner,
    codexHome: f.codexHome,
  });
  const result = await traceLineAncestry(recordingRunner, report.repository, report.location, report.provenance);
  assert.notEqual(result.status, "unavailable");
  assert.ok(calls.some((args) => args.includes("blame") && args.includes("-M") && args.includes("-C")));
  assert.equal(calls.some((args) => args.some((value) => value === "commit" || value === "add" || value === "mv")), false);
  assert.equal(calls.some((args) => args.includes("fetch") || args.includes("push") || args.includes("pull")), false);
});

test("SHA-256 repositories retain exact object IDs when supported", async (t) => {
  let f: Fixture;
  try {
    f = await fixture(t, "sha256");
  } catch (error: unknown) {
    t.skip(`SHA-256 Git repository unsupported: ${error instanceof Error ? error.message : "unknown"}`);
    return;
  }
  const targetPath = "src/sha256.ts";
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...MOVED_BLOCK, ...AFTER_CONTEXT]);
  const base = await commitFixture(f, [targetPath], "sha256 base");
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...AFTER_CONTEXT, ...MOVED_BLOCK]);
  const refactor = await commitFixture(f, [targetPath], "sha256 move");
  const report = await analyze(f, targetPath, 22);
  assert.equal(report.provenance.commit?.id, refactor);
  const result = await ancestry(f, report);
  assert.equal(result.status, "exact");
  if (result.status !== "exact") return;
  assert.equal(result.ancestor.commitId, base);
  assert.ok(result.ancestor.commitId.length > 40);
});

test("a shallow repository does not turn incomplete history into none", async (t) => {
  const source = await fixture(t);
  const targetPath = "src/shallow.ts";
  await writeFixtureFile(source.directory, targetPath, BLOCK);
  await commitFixture(source, [targetPath], "shallow base");
  await writeFixtureFile(source.directory, targetPath, ["const movedAbove = true;", ...BLOCK]);
  await commitFixture(source, [targetPath], "shallow move");

  const parent = await mkdtemp(path.join(os.tmpdir(), "whyline-ancestry-clone-"));
  const clone = path.join(parent, "clone");
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const cloned = await source.runner.run(["clone", "--depth=1", `file://${source.directory}`, clone], { cwd: parent });
  assert.equal(cloned.exitCode, 0, cloned.stderr.toString("utf8"));
  const shallow: Fixture = {
    directory: clone,
    codexHome: source.codexHome,
    globalConfig: source.globalConfig,
    runner: source.runner,
  };
  const report = await analyze(shallow, targetPath, 3);
  const result = await ancestry(shallow, report);
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "missing-history");
});

test("a missing required blob object remains typed unavailable", async (t) => {
  const f = await fixture(t);
  const targetPath = "src/missing-object.ts";
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...MOVED_BLOCK, ...AFTER_CONTEXT]);
  await commitFixture(f, [targetPath], "missing object base");
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...AFTER_CONTEXT, ...MOVED_BLOCK]);
  await commitFixture(f, [targetPath], "missing object move");
  const report = await analyze(f, targetPath, 22);
  const missingBlobRunner: GitRunner = {
    run: (args, options) => args[0] === "cat-file" && args[1] === "blob"
      ? Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from("missing object"), exitCode: 128, signal: null })
      : f.runner.run(args, options),
  };

  const result = await traceLineAncestry(
    missingBlobRunner,
    report.repository,
    report.location,
    report.provenance,
  );
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "unsupported-object");
});

test("ancestry Git process failures remain operational during direct tracing and analysis", async (t) => {
  const f = await fixture(t);
  const targetPath = "src/process-failure.ts";
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...MOVED_BLOCK, ...AFTER_CONTEXT]);
  await commitFixture(f, [targetPath], "process failure base");
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...AFTER_CONTEXT, ...MOVED_BLOCK]);
  await commitFixture(f, [targetPath], "process failure move");

  const report = await analyze(f, targetPath, 22);
  const rejectingRunner: GitRunner = {
    run: (args, options) => args.includes("blame") && args.includes("-M") && args.includes("-C")
      ? Promise.reject(new Error("spawn EACCES"))
      : f.runner.run(args, options),
  };

  await assert.rejects(
    traceLineAncestry(rejectingRunner, report.repository, report.location, report.provenance),
    (error: unknown) => error instanceof OperationalError && error.exitCode === 3,
  );
  await assert.rejects(
    analyzeLocation(`${targetPath}:22`, {
      currentDirectory: f.directory,
      git: rejectingRunner,
      codexHome: f.codexHome,
    }),
    (error: unknown) => error instanceof OperationalError && error.exitCode === 3,
  );
});

test("malformed movement blame porcelain remains an operational failure", async (t) => {
  const f = await fixture(t);
  const targetPath = "src/malformed-blame.ts";
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...MOVED_BLOCK, ...AFTER_CONTEXT]);
  await commitFixture(f, [targetPath], "malformed blame base");
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...AFTER_CONTEXT, ...MOVED_BLOCK]);
  await commitFixture(f, [targetPath], "malformed blame move");

  const report = await analyze(f, targetPath, 22);
  const malformedRunner: GitRunner = {
    run: (args, options) => args.includes("blame") && args.includes("-M") && args.includes("-C")
      ? Promise.resolve({ stdout: Buffer.from("not porcelain\n"), stderr: Buffer.alloc(0), exitCode: 0, signal: null })
      : f.runner.run(args, options),
  };

  await assert.rejects(
    traceLineAncestry(malformedRunner, report.repository, report.location, report.provenance),
    (error: unknown) => error instanceof OperationalError && error.exitCode === 3,
  );
});

test("merge-base exit 1 remains a normal negative reachability result", async (t) => {
  const f = await fixture(t);
  const targetPath = "src/negative-reachability.ts";
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...MOVED_BLOCK, ...AFTER_CONTEXT]);
  await commitFixture(f, [targetPath], "negative reachability base");
  await writeFixtureFile(f.directory, targetPath, [...BEFORE_CONTEXT, ...AFTER_CONTEXT, ...MOVED_BLOCK]);
  await commitFixture(f, [targetPath], "negative reachability move");

  const report = await analyze(f, targetPath, 22);
  const negativeReachabilityRunner: GitRunner = {
    run: (args, options) => args[0] === "merge-base" && args[1] === "--is-ancestor"
      ? Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1, signal: null })
      : f.runner.run(args, options),
  };

  const result = await traceLineAncestry(
    negativeReachabilityRunner,
    report.repository,
    report.location,
    report.provenance,
  );
  assert.equal(result.status, "uncertain");
  if (result.status !== "uncertain") return;
  assert.equal(result.reason, "candidate-not-exact");
});
