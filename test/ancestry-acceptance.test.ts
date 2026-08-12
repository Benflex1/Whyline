import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitProcess } from "../src/git/git-process.js";

const execFileAsync = promisify(execFile);
const BEFORE = Array.from({ length: 10 }, (_, index) => `const before${index} = \"before-${index}\";`);
const AFTER = Array.from({ length: 10 }, (_, index) => `const after${index} = \"after-${index}\";`);
const BLOCK = [
  "const tokenParserAnchor = \"acceptance exact token parser anchor\";",
  "const tokenParserSecond = \"acceptance second token parser anchor\";",
];

test("disposable real-Git CLI scenario reports textual refactor and exact predecessor", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-ancestry-acceptance-"));
  const globalConfig = path.join(directory, "empty-gitconfig");
  const codexHome = path.join(directory, "codex-home");
  await writeFile(globalConfig, "", "utf8");
  await mkdir(codexHome, { recursive: true });
  const environment = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
    CODEX_HOME: codexHome,
  };
  const runner = new GitProcess({ environment });
  t.after(async () => rm(directory, { recursive: true, force: true }));

  for (const args of [["init", "--initial-branch=main"], ["config", "user.name", "Whyline Acceptance"], ["config", "user.email", "acceptance@example.test"], ["config", "commit.gpgSign", "false"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const targetPath = path.join(directory, "src", "parser.ts");
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${[...BEFORE, ...BLOCK, ...AFTER].join("\n")}\n`, "utf8");
  for (const args of [["add", "--", "src/parser.ts"], ["commit", "--no-verify", "-m", "add token parser"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }
  const base = (await runner.run(["rev-parse", "HEAD"], { cwd: directory })).stdout.toString("utf8").trim();

  await writeFile(targetPath, `${[...BEFORE, ...AFTER, ...BLOCK].join("\n")}\n`, "utf8");
  for (const args of [["add", "--", "src/parser.ts"], ["commit", "--no-verify", "-m", "refactor: split parser"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }
  const refactor = (await runner.run(["rev-parse", "HEAD"], { cwd: directory })).stdout.toString("utf8").trim();
  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");

  const concise = await execFileAsync(process.execPath, [cliPath, "src/parser.ts:22"], {
    cwd: directory,
    env: { ...process.env, ...environment },
    maxBuffer: 64 * 1024,
  });
  assert.match(concise.stdout, new RegExp(`Textual last-touch: ${refactor.slice(0, 7)} \\"refactor: split parser\\"`));
  assert.match(concise.stdout, /Git ancestry: exact code predates that commit/);
  assert.match(concise.stdout, new RegExp(`earlier attribution: ${base.slice(0, 7)} \\"add token parser\\"`));
  assert.doesNotMatch(concise.stdout, /Relevant change|originated here|original commit/);

  const details = await execFileAsync(process.execPath, [cliPath, "--details", "src/parser.ts:22"], {
    cwd: directory,
    env: { ...process.env, ...environment },
    maxBuffer: 256 * 1024,
  });
  assert.match(details.stdout, /State/);
  assert.match(details.stdout, /Relevant change/);
  assert.match(details.stdout, new RegExp(`ancestor: ${base} src/parser\\.ts:12`));
  assert.match(details.stdout, /proof: lines=2, distinctive=2, alphanumeric=/);
});

test("compiled range CLI keeps exact, transformed, insufficient, dirty, and empty Codex outcomes distinct", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-declaration-acceptance-"));
  const globalConfig = path.join(directory, "empty-gitconfig");
  const codexHome = path.join(directory, "codex-home");
  await writeFile(globalConfig, "", "utf8");
  await mkdir(codexHome, { recursive: true });
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
    CODEX_HOME: codexHome,
  };
  const runner = new GitProcess({ environment });
  t.after(async () => rm(directory, { recursive: true, force: true }));

  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "Whyline Declaration Acceptance"],
    ["config", "user.email", "declaration-acceptance@example.test"],
    ["config", "commit.gpgSign", "false"],
  ] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const repositoryPath = "src/parser.ts";
  const targetPath = path.join(directory, repositoryPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const base = [
    "const movedAnchorOne = \"acceptance exact moved declaration alpha marker\";",
    "const movedAnchorTwo = \"acceptance exact moved declaration beta marker\";",
    "",
    "export class Parser {",
    "  parseToken(value: string): string {",
    "    const transformedAnchorOne = \"acceptance transformed declaration alpha marker\";",
    "    const transformedAnchorTwo = \"acceptance transformed declaration beta marker\";",
    "    return value.trim();",
    "  }",
    "",
    "  parseExact(value: string): string {",
    "    return value.trim();",
    "    const methodMovedAnchorOne = \"acceptance exact method alpha marker\";",
    "    const methodMovedAnchorTwo = \"acceptance exact method beta marker\";",
    "  }",
    "",
    "  parseWeak(value: string): string {",
    "    return value + \"acceptance weak original\";",
    "  }",
    "}",
  ].join("\n") + "\n";
  await writeFile(targetPath, base, "utf8");
  for (const args of [["add", "--", repositoryPath], ["commit", "--no-verify", "-m", "add parser declarations"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const edited = [
    "export class Parser {",
    "  parseToken(value: string): string {",
    "    const transformedAnchorOne = \"acceptance transformed declaration alpha marker\";",
    "    const transformedAnchorTwo = \"acceptance transformed declaration beta marker\";",
    "    const editedLine = value.toUpperCase();",
    "    return value.trim() + editedLine;",
    "  }",
    "",
    "  parseExact(value: string): string {",
    "    return value.trim();",
    "    const methodMovedAnchorOne = \"acceptance exact method alpha marker\";",
    "    const methodMovedAnchorTwo = \"acceptance exact method beta marker\";",
    "  }",
    "",
    "  parseWeak(value: string): string {",
    "    return value + \"acceptance weak edited\";",
    "  }",
    "}",
    "",
    "const movedAnchorOne = \"acceptance exact moved declaration alpha marker\";",
    "const movedAnchorTwo = \"acceptance exact moved declaration beta marker\";",
  ].join("\n") + "\n";
  await writeFile(targetPath, edited, "utf8");
  for (const args of [["add", "--", repositoryPath], ["commit", "--no-verify", "-m", "edit parser declarations"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const dirty = edited.replace(
    "    return value + \"acceptance weak edited\";",
    "    return value + \"acceptance weak edited\";\n    const dirtyLine = value.length;",
  );
  await writeFile(targetPath, dirty, "utf8");

  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const range = repositoryPath + ":1-" + dirty.trimEnd().split("\n").length;
  const concise = await execFileAsync(process.execPath, [cliPath, range], {
    cwd: directory,
    env: environment,
    maxBuffer: 256 * 1024,
  });
  assert.match(concise.stdout, /Git ancestry/);
  assert.match(concise.stdout, /exact predecessor/);
  assert.match(concise.stdout, /verified direct-parent declaration correspondence/);
  assert.match(concise.stdout, /not established/);
  assert.match(concise.stdout, /uncommitted|not run/i);
  assert.match(concise.stdout, /AI provenance|no reliable Codex match/);
  assert.doesNotMatch(concise.stdout, /historical symbol|same symbol|semantic equivalence|origin|authorship|move versus copy/i);

  const details = await execFileAsync(process.execPath, [cliPath, "--details", range], {
    cwd: directory,
    env: environment,
    maxBuffer: 256 * 1024,
  });
  assert.match(details.stdout, /relationship: direct-parent-declaration/);
  assert.match(details.stdout, /syntactic key: kind=method, qualified-name=Parser\.parseToken/);
  assert.match(details.stdout, /anchor: lines=/);
  assert.match(details.stdout, /Raw prompts, reasoning, commands, transcript paths, and patch payloads are omitted/);
  assert.doesNotMatch(details.stdout, /acceptance transformed declaration alpha marker|acceptance exact moved declaration alpha marker|AST|source excerpt/i);
});
