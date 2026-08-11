import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitProcess } from "../src/git/git-process.js";
import { discoverRepositoryContext } from "../src/git/repository-context.js";
import { parseLocationQuery } from "../src/location/parse-location.js";
import {
  resolveCurrentSource,
  resolveRangeLocation,
  resolvedRangeLocationFromSource,
} from "../src/location/resolve-location.js";
import { InvalidInputError } from "../src/whyline-error.js";

test("parses an inclusive range query", () => {
  assert.deepEqual(parseLocationQuery("src/parser.ts:40-55"), {
    kind: "range",
    input: "src/parser.ts:40-55",
    file: "src/parser.ts",
    startLine: 40,
    endLine: 55,
  });
});

test("accepts a same-line range and preserves single-line compatibility", () => {
  assert.deepEqual(parseLocationQuery("src/parser.ts:40-40"), {
    kind: "range",
    input: "src/parser.ts:40-40",
    file: "src/parser.ts",
    startLine: 40,
    endLine: 40,
  });
  assert.deepEqual(parseLocationQuery("src/parser.ts:40"), {
    kind: "line",
    input: "src/parser.ts:40",
    file: "src/parser.ts",
    line: 40,
  });
});

test("keeps unusual filenames intact in ranges", () => {
  for (const [input, file] of [
    ["folder/space name/ä.ts:2-3", "folder/space name/ä.ts"],
    ["folder/colon:name.ts:2-3", "folder/colon:name.ts"],
    ["-leading.ts:1-2", "-leading.ts"],
    ["--generated.ts:1-2", "--generated.ts"],
  ] as const) {
    const result = parseLocationQuery(input);
    assert.deepEqual(result, {
      kind: "range",
      input,
      file,
      startLine: file.startsWith("folder/") ? 2 : 1,
      endLine: file.startsWith("folder/") ? 3 : 2,
    });
  }
});

test("rejects invalid, reversed, and over-bound ranges", () => {
  for (const input of [
    "",
    "src/parser.ts:",
    "src/parser.ts:0-1",
    "src/parser.ts:-1-2",
    "src/parser.ts:1-0",
    "src/parser.ts:2-1",
    "src/parser.ts:1-201",
    "src/parser.ts:1-two",
    "src/parser.ts:1-2-3",
  ]) {
    assert.throws(
      () => parseLocationQuery(input),
      (error: unknown) => error instanceof InvalidInputError && error.exitCode === 2,
      input,
    );
  }
});

test("resolves a range from one current UTF-8 file snapshot", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-range-location-"));
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
    ["config", "user.name", "Whyline Test"],
    ["config", "user.email", "whyline@example.test"],
  ] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const relativePath = "dir/space: name/ä.ts";
  const absolutePath = path.join(directory, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "first\nümlaut\nthird\n", "utf8");
  for (const args of [["add", "--", relativePath], ["commit", "--no-verify", "-m", "fixture"]] as const) {
    const result = await runner.run(args, { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
  }

  const repository = await discoverRepositoryContext(runner, directory);
  const input = relativePath + ":1-2";
  const query = parseLocationQuery(input);
  assert.equal(query.kind, "range");
  if (query.kind !== "range") throw new Error("expected range query");
  const resolved = await resolveRangeLocation(
    query,
    repository,
    runner,
    directory,
  );
  assert.equal(resolved.input, input);
  assert.equal(resolved.repositoryPath, relativePath);
  assert.equal(resolved.startLine, 1);
  assert.equal(resolved.endLine, 2);
  assert.deepEqual(resolved.lineContents, ["first", "ümlaut"]);
  assert.equal(resolved.targetState, "clean");
  assert.equal(resolved.targetDirty, false);
  assert.equal(resolved.fileSnapshot.digest.length, 64);

  const source = await resolveCurrentSource(relativePath, repository, runner, directory);
  const fromSameSource = resolvedRangeLocationFromSource(query, source);
  assert.equal(source.text, "first\nümlaut\nthird\n");
  assert.equal(fromSameSource.fileSnapshot.digest, resolved.fileSnapshot.digest);
  assert.deepEqual(fromSameSource.lineContents, resolved.lineContents);
  assert.equal(fromSameSource.repositoryPath, resolved.repositoryPath);
});
