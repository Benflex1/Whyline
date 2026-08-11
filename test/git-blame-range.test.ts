import assert from "node:assert/strict";
import test from "node:test";

import type { GitResult, GitRunner } from "../src/git/git-process.js";
import { blameRange, parseBlamePorcelainRange } from "../src/git/blame-range.js";
import type { RepositoryContext } from "../src/provenance/model.js";
import { OperationalError } from "../src/whyline-error.js";

const COMMIT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0000000000000000000000000000000000000000";

function record(
  objectId: string,
  originalLine: number,
  finalLine: number,
  filename: string,
  content: string,
  previous?: string,
): string {
  return [
    objectId + " " + originalLine + " " + finalLine + " 1",
    "author Test Author",
    "author-mail <author@example.test>",
    "author-time 1",
    "author-tz +0000",
    "committer Test Committer",
    "committer-mail <committer@example.test>",
    "committer-time 1",
    "committer-tz +0000",
    ...(previous === undefined ? [] : ["previous " + previous + " old/ä.ts"]),
    "filename " + filename,
    "\t" + content,
  ].join("\n");
}

const context = {
  worktreeRoot: "/repo",
  gitDir: "/repo/.git",
  commonGitDir: "/repo/.git",
  objectFormat: "sha1",
  isShallow: false,
  headCommit: COMMIT_A,
  branch: "main",
  worktrees: [],
} satisfies RepositoryContext;

test("parses every committed and zero-object range blame record", () => {
  const value = [
    record(COMMIT_A, 10, 40, "src/ä.ts", "const first = 1;", COMMIT_B),
    record(ZERO, 41, 41, "src/ä.ts", "locally changed\tvalue"),
    record(COMMIT_B, 12, 42, "src/ä.ts", "const third = 3;"),
  ].join("\n");

  const facts = parseBlamePorcelainRange(value, "src/ä.ts", 40, 42);
  assert.equal(facts.length, 3);
  assert.equal(facts[0]?.queryLine, 40);
  assert.equal(facts[0]?.blame.objectId, COMMIT_A);
  assert.equal(facts[0]?.blame.previousPath, "old/ä.ts");
  assert.equal(facts[1]?.queryLine, 41);
  assert.equal(facts[1]?.blame.uncommitted, true);
  assert.equal(facts[1]?.blame.lineContent, "locally changed\tvalue");
  assert.equal(facts[2]?.queryLine, 42);
  assert.equal(facts[2]?.blame.filename, "src/ä.ts");
});

test("rejects malformed or incomplete range porcelain", () => {
  for (const value of [
    "",
    "not a header",
    record(COMMIT_A, 10, 40, "src/file.ts", "one") + "\n" + record(COMMIT_A, 11, 40, "src/file.ts", "duplicate"),
    record(COMMIT_A, 10, 40, "src/file.ts", "one") + "\n" + record(COMMIT_A, 11, 42, "src/file.ts", "gap"),
    COMMIT_A + " bad 40\nfilename src/file.ts\n\tline",
    COMMIT_A + " 10 40\nfilename src/file.ts",
  ]) {
    assert.throws(
      () => parseBlamePorcelainRange(value, "src/file.ts", 40, 42),
      (error: unknown) => error instanceof OperationalError,
    );
  }
});

class RecordingRunner implements GitRunner {
  public readonly calls: Array<readonly string[]> = [];

  public constructor(private readonly output: Buffer) {}

  public async run(
    args: readonly string[],
    _options: { readonly cwd: string; readonly input?: Uint8Array },
  ): Promise<GitResult> {
    this.calls.push([...args]);
    return {
      exitCode: 0,
      stdout: this.output,
      stderr: Buffer.alloc(0),
      signal: null,
    };
  }
}

test("uses exactly one argv-only baseline range blame command", async () => {
  const runner = new RecordingRunner(Buffer.from(
    record(COMMIT_A, 1, 40, "path with spaces/ä.ts", "line"),
    "utf8",
  ));
  const facts = await blameRange(runner, context, "path with spaces/ä.ts", 40, 40);

  assert.equal(facts.length, 1);
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], [
    "-c",
    "core.quotePath=false",
    "-c",
    "color.ui=false",
    "blame",
    "--line-porcelain",
    "-L",
    "40,40",
    "--",
    "path with spaces/ä.ts",
  ]);
});
