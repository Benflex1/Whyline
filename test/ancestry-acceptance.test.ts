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
