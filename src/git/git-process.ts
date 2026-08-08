import { spawn } from "node:child_process";

import { OperationalError } from "../whyline-error.js";

export interface GitRunOptions {
  readonly cwd: string;
  readonly input?: Uint8Array;
}

export interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
}

export interface GitRunner {
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult>;
}

export interface GitProcessOptions {
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

const FIXED_GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  LANG: "C",
  TERM: "dumb",
};

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

function safeErrorDetail(value: Buffer): string {
  return value
    .toString("utf8")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * The only production boundary for Git. It deliberately uses spawn with
 * shell:false and keeps stdout as bytes so NUL-delimited Git formats remain
 * lossless until their parser chooses a decoding.
 */
export class GitProcess implements GitRunner {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;

  public constructor(options: GitProcessOptions = {}) {
    this.executable = options.executable ?? "git";
    this.environment = {
      ...process.env,
      ...FIXED_GIT_ENVIRONMENT,
      ...options.environment,
    };
  }

  public run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    if (args.some((argument) => hasNul(argument))) {
      return Promise.reject(new OperationalError("Git argument contains a NUL byte"));
    }

    return new Promise<GitResult>((resolve, reject) => {
      let child;
      try {
        child = spawn(this.executable, [...args], {
          cwd: options.cwd,
          env: this.environment,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error: unknown) {
        reject(error);
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error: Error) => reject(error));
      child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: exitCode ?? -1,
          signal,
        });
      });

      if (options.input === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(options.input);
      }
    });
  }
}

export const defaultGitProcess = new GitProcess();

export function decodeGitUtf8(value: Buffer): string {
  return value.toString("utf8");
}

export function gitErrorMessage(result: GitResult, operation: string): string {
  const detail = safeErrorDetail(result.stderr);
  return detail.length === 0 ? `${operation} failed` : `${operation} failed: ${detail}`;
}

export async function requireGitSuccess(
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
  operation: string,
  input?: Uint8Array,
): Promise<GitResult> {
  let result: GitResult;
  try {
    result = await runner.run(args, input === undefined ? { cwd } : { cwd, input });
  } catch (error: unknown) {
    if (error instanceof OperationalError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "unknown process error";
    throw new OperationalError(`${operation} could not start: ${message}`);
  }
  if (result.exitCode !== 0) {
    throw new OperationalError(gitErrorMessage(result, operation));
  }
  return result;
}
