import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GitProcess } from "../src/git/git-process.js";

const execFileAsync = promisify(execFile);

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function command(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(executable, args, { ...options, maxBuffer: 256 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    const failed = error as Error & { readonly code: number | string; readonly stdout?: string; readonly stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : Number(failed.code),
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

test("disposable real CLI resolves a decorated overloaded TSX method conservatively", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-symbol-acceptance-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
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
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "Whyline Symbol Acceptance"],
    ["config", "user.email", "symbol-acceptance@example.test"],
    ["config", "commit.gpgSign", "false"],
  ] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const filename = "-- parser: 名.tsx";
  const repositoryPath = path.join("src", filename);
  const targetPath = path.join(directory, repositoryPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const base = [
    "export class Parser {",
    "  parseToken(value: string): string;",
    "  parseToken(value: number): string;",
    "  @logged",
    "  parseToken(value: string | number): string {",
    "    const movedAnchorOne = \"distinctive moved parser token anchor one\";",
    "    const movedAnchorTwo = \"distinctive moved parser token anchor two\";",
    "    const movedAnchorThree = \"distinctive moved parser token anchor three\";",
    "    const movedAnchorFour = \"distinctive moved parser token anchor four\";",
    "    const movedBoundaryOne = \"distinctive moved boundary parser line one\";",
    "    const movedBoundaryTwo = \"distinctive moved boundary parser line two\";",
    "    const view = <span>{value}</span>;",
    "    return String(value) + movedAnchorOne + view;",
    "  }",
    "}",
    "class OtherParser {",
    "  parseToken() { return \"unrelated simple name\"; }",
    "}",
  ].join("\n") + "\n";
  await writeFile(targetPath, base, "utf8");
  for (const args of [["add", "--", repositoryPath], ["commit", "--no-verify", "-m", "add overloaded parser"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const edited = base.replace(
    "    return String(value) + movedAnchorOne + view;",
    "    return String(value) + movedAnchorOne + view + \"edited\";",
  );
  await writeFile(targetPath, edited, "utf8");
  for (const args of [["add", "--", repositoryPath], ["commit", "--no-verify", "-m", "edit parser interior"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const movedBlock = [
    "    const movedBoundaryOne = \"distinctive moved boundary parser line one\";",
    "    const movedBoundaryTwo = \"distinctive moved boundary parser line two\";",
  ].join("\n");
  const moved = edited
    .replace(movedBlock + "\n", "")
    .replace(
      "    const movedAnchorOne = \"distinctive moved parser token anchor one\";",
      movedBlock + "\n    const movedAnchorOne = \"distinctive moved parser token anchor one\";",
    );
  await writeFile(targetPath, moved, "utf8");
  for (const args of [["add", "--", repositoryPath], ["commit", "--no-verify", "-m", "move parser block"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const dirty = moved.replace(
    "    const view = <span>{value}</span>;",
    "    const view = <span data-dirty>{value}</span>;",
  );
  await writeFile(targetPath, dirty, "utf8");

  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const concise = await command(process.execPath, [cliPath, "--symbol", "Parser.parseToken", repositoryPath], {
    cwd: directory,
    env: environment,
  });
  assert.equal(concise.code, 0, concise.stderr);
  assert.match(concise.stdout, new RegExp(`${repositoryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — Parser\\.parseToken`));
  assert.match(concise.stdout, /method, lines 2-14/);
  assert.match(concise.stdout, /add overloaded parser|edit parser interior|move parser block/);
  assert.match(concise.stdout, /exact predecessor/);
  assert.match(concise.stdout, /uncommitted|not run/);
  assert.doesNotMatch(concise.stdout, /symbol origin|historical symbol identity|same-named historical declaration/i);

  const details = await command(process.execPath, [cliPath, "--details", "--symbol", "Parser.parseToken", repositoryPath], {
    cwd: directory,
    env: environment,
  });
  assert.equal(details.code, 0, details.stderr);
  assert.match(details.stdout, /Symbol resolution/);
  assert.match(details.stdout, /language: TypeScript/);
  assert.match(details.stdout, /dialect: tsx/);
  assert.match(details.stdout, /parser: TypeScript 5\.9\.3/);
  assert.match(details.stdout, /resolved range: .*:2-14/);

  const ambiguous = await command(process.execPath, [cliPath, "--symbol", "parseToken", repositoryPath], {
    cwd: directory,
    env: environment,
  });
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.stderr, /symbol `parseToken` is ambiguous/);
  assert.match(ambiguous.stderr, /Parser\.parseToken/);
  assert.match(ambiguous.stderr, /OtherParser\.parseToken/);

  const hugePath = path.join(directory, "src", "huge.ts");
  await writeFile(hugePath, [
    "class Huge {",
    ...Array.from({ length: 199 }, (_value, index) => `  // ${index + 1}`),
    "}",
  ].join("\n") + "\n", "utf8");
  const overLimit = await command(process.execPath, [cliPath, "--symbol", "Huge", "src/huge.ts"], {
    cwd: directory,
    env: environment,
  });
  assert.equal(overLimit.code, 2);
  assert.match(overLimit.stderr, /symbol `Huge` spans 201 lines \(1-201\)/);
  assert.match(overLimit.stderr, /current limit is 200 lines/);
});
