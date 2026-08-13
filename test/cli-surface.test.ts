import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function command(args: readonly string[], cwd: string): Promise<CommandResult> {
  try {
    const result = await execFileAsync(process.execPath, args, { cwd, maxBuffer: 256 * 1024 });
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

test("compiled CLI help is successful and describes the public release surface", async (t) => {
  const unrelatedDirectory = await mkdtemp(path.join(os.tmpdir(), "whyline-cli-surface-"));
  t.after(async () => rm(unrelatedDirectory, { recursive: true, force: true }));

  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const result = await command([cliPath, "--help"], unrelatedDirectory);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--details/);
  assert.match(result.stdout, /--symbol <selector> <file>/);
  assert.match(result.stdout, /--version/);
  assert.match(result.stdout, /Examples:/);
  assert.match(result.stdout, /whyline src\/parser\.ts:42/);
  assert.match(result.stdout, /whyline src\/parser\.ts:40-55/);
  assert.match(result.stdout, /whyline --symbol parseExpression src\/parser\.ts/);
  assert.match(result.stdout, /whyline --details src\/parser\.ts:42/);
  assert.match(result.stdout, /Node\.js 24\+/);
  assert.match(result.stdout, /Git 2\.36\+/);
  assert.match(result.stdout, /Linux and macOS/);
  assert.match(result.stdout, /does not claim authorship/i);
});

test("compiled CLI reads its packaged version from an unrelated working directory", async (t) => {
  const unrelatedDirectory = await mkdtemp(path.join(os.tmpdir(), "whyline-cli-version-"));
  t.after(async () => rm(unrelatedDirectory, { recursive: true, force: true }));

  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const result = await command([cliPath, "--version"], unrelatedDirectory);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "0.1.0\n");
});

test("CLI runs when Node is given npm's symlinked bin path", async (t) => {
  const unrelatedDirectory = await mkdtemp(path.join(os.tmpdir(), "whyline-cli-bin-"));
  t.after(async () => rm(unrelatedDirectory, { recursive: true, force: true }));

  const binDirectory = path.join(unrelatedDirectory, "node_modules", ".bin");
  await mkdir(binDirectory, { recursive: true });
  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const binPath = path.join(binDirectory, "whyline");
  await symlink(cliPath, binPath);

  const result = await command([binPath, "--help"], unrelatedDirectory);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage:/);
});
