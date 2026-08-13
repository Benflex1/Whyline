import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GitProcess } from "../src/git/git-process.js";

const execFileAsync = promisify(execFile);

async function cli(
  directory: string,
  codexHome: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const environment = {
    ...process.env,
    CODEX_HOME: codexHome,
    GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(directory, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
  };
  try {
    const result = await execFileAsync(process.execPath, [
      path.resolve(process.cwd(), "dist/src/cli/main.js"),
      ...args,
    ], { cwd: directory, env: environment, maxBuffer: 256 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const failed = error as Error & { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
    return { code: failed.code ?? 3, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function runGit(runner: GitProcess, directory: string, args: readonly string[]): Promise<void> {
  const result = await runner.run(args, { cwd: directory });
  assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
}

test("compiled CLI accepts a conservative tracked worktree correlation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-worktree-acceptance-"));
  const codexHome = path.join(directory, "codex-home");
  const config = path.join(directory, "gitconfig");
  await writeFile(config, "", "utf8");
  await mkdir(codexHome, { recursive: true });
  const runner = new GitProcess({
    environment: {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    },
  });
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await runGit(runner, directory, ["init", "--initial-branch=main"]);
  await runGit(runner, directory, ["config", "user.name", "Whyline Acceptance"]);
  await runGit(runner, directory, ["config", "user.email", "acceptance@example.test"]);
  await runGit(runner, directory, ["config", "commit.gpgSign", "false"]);
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(path.join(directory, "src/target.ts"), "const baseline = true;\n", "utf8");
  await runGit(runner, directory, ["add", "--", "src/target.ts"]);
  await runGit(runner, directory, ["commit", "--no-verify", "-m", "baseline"]);

  const first = "const acceptanceWorktreeAlpha = \"alpha-value-with-material\";";
  const second = "const acceptanceWorktreeBeta = \"beta-value-with-material\";";
  await writeFile(path.join(directory, "src/target.ts"), `${first}\n${second}\n`, "utf8");
  const sessionPath = path.join(codexHome, "sessions", "2026", "08", "13", "acceptance.jsonl");
  await mkdir(path.dirname(sessionPath), { recursive: true });
  const patchCall = {
    timestamp: "2026-08-13T10:00:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: "acceptance-patch",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: src/target.ts\n*** End Patch",
    },
  };
  const patchResult = {
    timestamp: "2026-08-13T10:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "patch_apply_end",
      call_id: "acceptance-patch",
      status: "completed",
      success: true,
      changes: {
        "src/target.ts": {
          type: "update",
          unified_diff: `@@ -1,1 +1,2 @@\n-const baseline = true;\n+${first}\n+${second}`,
        },
      },
    },
  };
  await writeFile(sessionPath, `${JSON.stringify({
    timestamp: "2026-08-13T09:59:59.000Z",
    type: "session_meta",
    payload: { session_id: "acceptance-session", cwd: directory },
  })}\n${JSON.stringify(patchCall)}\n${JSON.stringify(patchResult)}\n`, "utf8");

  const summary = await cli(directory, codexHome, ["src/target.ts:1"]);
  assert.equal(summary.code, 0, summary.stderr);
  assert.match(summary.stdout, /uncommitted; modified against HEAD [0-9a-f]{7}/);
  assert.match(summary.stdout, /likely Codex session/);
  assert.match(summary.stdout, /current worktree change/);
  assert.doesNotMatch(summary.stdout, /acceptance\.jsonl|\/tmp|prompt|reasoning|authorship|origin/i);

  const details = await cli(directory, codexHome, ["--details", "src/target.ts:1"]);
  assert.equal(details.code, 0, details.stderr);
  assert.match(details.stdout, /target kind: worktree/);
  assert.match(details.stdout, /staging: unstaged/);
  assert.doesNotMatch(details.stdout, /acceptance\.jsonl|unified_diff/);
});

test("compiled CLI preserves insufficient worktree material as a non-Codex outcome", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-worktree-insufficient-"));
  const codexHome = path.join(directory, "codex-home");
  const config = path.join(directory, "gitconfig");
  await writeFile(config, "", "utf8");
  await mkdir(codexHome, { recursive: true });
  const runner = new GitProcess({
    environment: {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    },
  });
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await runGit(runner, directory, ["init", "--initial-branch=main"]);
  await runGit(runner, directory, ["config", "user.name", "Whyline Acceptance"]);
  await runGit(runner, directory, ["config", "user.email", "acceptance@example.test"]);
  await writeFile(path.join(directory, "tiny.ts"), "return;\n", "utf8");
  await runGit(runner, directory, ["add", "--", "tiny.ts"]);
  await runGit(runner, directory, ["commit", "--no-verify", "-m", "baseline"]);
  await writeFile(path.join(directory, "tiny.ts"), "throw;\n", "utf8");
  const result = await cli(directory, codexHome, ["tiny.ts:1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /worktree material is insufficient/);
  assert.doesNotMatch(result.stdout, /Codex session|No reliable Codex/);
});
