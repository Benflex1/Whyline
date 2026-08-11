import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitProcess } from "../src/git/git-process.js";

const execFileAsync = promisify(execFile);

test("disposable mixed-range CLI acceptance keeps textual, exact, and dirty spans distinct", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-range-acceptance-"));
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

  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "Whyline Range Acceptance"],
    ["config", "user.email", "range-acceptance@example.test"],
    ["config", "commit.gpgSign", "false"],
  ] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const targetPath = path.join(directory, "src", "parser.ts");
  await mkdir(path.dirname(targetPath), { recursive: true });
  const movedBlock = [
    "const movedParserAnchor = \"range acceptance moved parser anchor with distinctive content\";",
    "const movedParserSecond = \"range acceptance second parser line with distinctive content\";",
    "const movedParserThird = \"range acceptance third parser line with distinctive content\";",
    "const movedParserFourth = \"range acceptance fourth parser line with distinctive content\";",
  ];
  const baseLines = [
    "const header = \"stable parser header\";",
    ...movedBlock,
    "const stableBaseOne = \"base parser line one\";",
    "const stableBaseTwo = \"base parser line two\";",
  ];
  await writeFile(targetPath, baseLines.join("\n") + "\n", "utf8");
  for (const args of [["add", "--", "src/parser.ts"], ["commit", "--no-verify", "-m", "add token parser"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const refactoredLines = [
    "const header = \"stable parser header\";",
    "const stableBaseOne = \"base parser line one\";",
    "const stableBaseTwo = \"base parser line two\";",
    ...movedBlock,
  ];
  await writeFile(targetPath, refactoredLines.join("\n") + "\n", "utf8");
  for (const args of [["add", "--", "src/parser.ts"], ["commit", "--no-verify", "-m", "refactor: split parser"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const separateLines = [
    ...refactoredLines,
    "const escapedTokenOne = \"separately attributed escaped token line one\";",
    "const escapedTokenTwo = \"separately attributed escaped token line two\";",
  ];
  await writeFile(targetPath, separateLines.join("\n") + "\n", "utf8");
  for (const args of [["add", "--", "src/parser.ts"], ["commit", "--no-verify", "-m", "handle escaped tokens"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  await writeFile(targetPath, [
    ...separateLines,
    "const locallyChangedOne = \"uncommitted parser line one\";",
    "const locallyChangedTwo = \"uncommitted parser line two\";",
  ].join("\n") + "\n", "utf8");

  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const concise = await execFileAsync(process.execPath, [cliPath, "src/parser.ts:1-11"], {
    cwd: directory,
    env: { ...process.env, ...environment },
    maxBuffer: 128 * 1024,
  });
  assert.match(concise.stdout, /src\/parser\.ts:1-11/);
  assert.match(concise.stdout, /1, 4-7\s+[0-9a-f]{7}\s+"add token parser"/);
  assert.match(concise.stdout, /2-3\s+[0-9a-f]{7}\s+"refactor: split parser"/);
  assert.match(concise.stdout, /8-9\s+[0-9a-f]{7}\s+"handle escaped tokens"/);
  assert.match(concise.stdout, /10-11\s+uncommitted/);
  assert.match(concise.stdout, /2-3\s+exact predecessor/);
  assert.match(concise.stdout, /AI provenance/);
  assert.match(concise.stdout, /10-11\s+not run/);
  assert.doesNotMatch(concise.stdout, /semantic origin|originated here|original commit/);

  const details = await execFileAsync(process.execPath, [cliPath, "--details", "src/parser.ts:1-11"], {
    cwd: directory,
    env: { ...process.env, ...environment },
    maxBuffer: 256 * 1024,
  });
  assert.match(details.stdout, /Textual groups/);
  assert.match(details.stdout, /Exact ancestry/);
  assert.match(details.stdout, /Codex provenance/);
  assert.match(details.stdout, /work-bound groups: 0/);
  assert.doesNotMatch(details.stdout, /\/private\/|private evidence|private body/i);
});
