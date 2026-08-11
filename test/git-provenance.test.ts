import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBlamePorcelain } from "../src/git/blame-line.js";
import { GitProcess, type GitRunner } from "../src/git/git-process.js";
import { parseNameStatus, parseUnifiedDiff, selectParent } from "../src/git/inspect-commit.js";
import { parseLocation } from "../src/location/parse-location.js";
import { analyzeLocation } from "../src/provenance/explain-location.js";
import type { GitCommit, WhylineReport } from "../src/provenance/model.js";
import type { AnalysisHooks } from "../src/provenance/explain-location.js";
import { InvalidInputError, WhylineError } from "../src/whyline-error.js";

const execFileAsync = promisify(execFile);

interface Fixture {
  readonly directory: string;
  readonly globalConfig: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly runner: GitProcess;
}

async function fixture(t: test.TestContext, objectFormat?: "sha1" | "sha256"): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whyline-git-test-"));
  const globalConfig = path.join(directory, "empty-gitconfig");
  const codexHome = path.join(directory, "synthetic-codex-home");
  await writeFile(globalConfig, "", "utf8");
  await mkdir(codexHome, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
    CODEX_HOME: codexHome,
  };
  const runner = new GitProcess({ environment });
  const initArgs = ["init", "--initial-branch=main"];
  if (objectFormat === "sha256") initArgs.push("--object-format=sha256");
  const initialized = await runner.run(initArgs, { cwd: directory });
  if (initialized.exitCode !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(initialized.stderr.toString("utf8"));
  }
  await gitChecked({ directory, runner }, ["config", "user.name", "Fixture Author"]);
  await gitChecked({ directory, runner }, ["config", "user.email", "fixture@example.test"]);
  await gitChecked({ directory, runner }, ["config", "commit.gpgSign", "false"]);
  await gitChecked({ directory, runner }, ["config", "core.quotepath", "false"]);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, globalConfig, environment, runner };
}

async function gitRaw(
  fixtureValue: Pick<Fixture, "directory" | "runner"> & Partial<Pick<Fixture, "environment">>,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
  input?: Uint8Array,
): Promise<Awaited<ReturnType<GitProcess["run"]>>> {
  const runner = Object.keys(extraEnvironment).length === 0
    ? fixtureValue.runner
    : new GitProcess({ environment: { ...(fixtureValue.environment ?? {}), ...extraEnvironment } });
  return runner.run(args, input === undefined ? { cwd: fixtureValue.directory } : { cwd: fixtureValue.directory, input });
}

async function gitChecked(
  fixtureValue: Pick<Fixture, "directory" | "runner"> & Partial<Pick<Fixture, "environment">>,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
  input?: Uint8Array,
): Promise<Buffer> {
  const result = await gitRaw(fixtureValue, args, extraEnvironment, input);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

async function writeFixtureFile(directory: string, relativePath: string, content: string | Uint8Array): Promise<void> {
  const filePath = path.join(directory, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function writeCodexPatchTranscript(
  codexHome: string,
  sessionId: string,
  cwd: string,
  commit: string,
): Promise<void> {
  const sourcePath = path.join(codexHome, "sessions", "2026", "08", "08", `${sessionId}.jsonl`);
  const callId = `call-${sessionId}`;
  const firstLine = "const cliHomeFirst = \"target-alpha\";";
  const secondLine = "const cliHomeSecond = \"target-beta\";";
  const unifiedDiff = `@@ -0,0 +1,2 @@\n+${firstLine}\n+${secondLine}\n`;
  const records = [
    {
      timestamp: "2026-08-08T01:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: sessionId,
        timestamp: "2026-08-08T01:00:00.000Z",
        cwd,
        originator: "t3code_desktop",
        source: "vscode",
        cli_version: "0.147.0",
        git: { branch: "main", commit_hash: commit },
      },
    },
    {
      timestamp: "2026-08-08T01:00:01.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: `item-${sessionId}`,
        call_id: callId,
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: cli.ts\n@@ -0,0 +1,2 @@\n*** End Patch",
      },
    },
    {
      timestamp: "2026-08-08T01:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: callId,
        status: "completed",
        success: true,
        changes: {
          [path.join(cwd, "cli.ts")]: {
            type: "update",
            unified_diff: unifiedDiff,
          },
        },
      },
    },
  ];
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(
    sourcePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

async function commitFixture(
  fixtureValue: Fixture,
  message: string,
  date: string,
): Promise<string> {
  await gitChecked(fixtureValue, ["add", "-A"]);
  await gitChecked(
    fixtureValue,
    ["commit", "--no-verify", "-m", message],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  );
  return (await gitChecked(fixtureValue, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

async function analyze(
  fixtureValue: Fixture,
  relativeLocation: string,
  line = 1,
  options: { readonly currentDirectory?: string; readonly git?: GitRunner; readonly hooks?: AnalysisHooks; readonly codexHome?: string } = {},
): Promise<WhylineReport> {
  const codexHome = options.codexHome ?? fixtureValue.environment.CODEX_HOME;
  return analyzeLocation(`${relativeLocation}:${line}`, {
    currentDirectory: options.currentDirectory ?? fixtureValue.directory,
    git: options.git ?? fixtureValue.runner,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(codexHome === undefined ? {} : { codexHome }),
  });
}

async function expectExitCode(
  operation: Promise<unknown>,
  exitCode: 2 | 3,
  message?: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    if (!(error instanceof WhylineError) || error.exitCode !== exitCode) return false;
    return message === undefined || message.test(error.message);
  });
}

function commitId(report: WhylineReport): string {
  assert.ok(report.provenance.commit !== null);
  return report.provenance.commit.id;
}

test("root commit attribution includes the empty-tree comparison and added hunk", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "src/root.ts", "const root = true;\n");
  const rootCommit = await commitFixture(f, "root: add file", "2026-08-01T00:00:00Z");

  const report = await analyze(f, "src/root.ts");
  assert.equal(commitId(report), rootCommit);
  assert.equal(report.provenance.parent?.kind, "root");
  assert.equal(report.provenance.changedPaths[0]?.kind, "added");
  assert.equal(report.provenance.relevantHunks[0]?.targetLineKind, "added");
  assert.equal(report.repository.objectFormat, "sha1");
});

test("a later line edit selects the sole parent and the modified hunk", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "src/edit.ts", "first\nold value\nthird\n");
  const rootCommit = await commitFixture(f, "edit: establish file", "2026-08-01T00:00:00Z");
  await writeFixtureFile(f.directory, "src/edit.ts", "first\nnew value\nthird\n");
  const editCommit = await commitFixture(f, "fix: update value", "2026-08-02T00:00:00Z");

  const report = await analyze(f, "src/edit.ts", 2);
  assert.equal(commitId(report), editCommit);
  assert.equal(report.provenance.parent?.kind, "commit");
  assert.equal(report.provenance.parent?.kind === "commit" ? report.provenance.parent.commitId : null, rootCommit);
  assert.equal(report.provenance.changedPaths[0]?.kind, "modified");
  assert.equal(report.provenance.relevantHunks[0]?.targetLineKind, "added");
});

test("clean committed lines are successful and report a clean file", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "clean.ts", "stable\n");
  const commit = await commitFixture(f, "clean: add stable line", "2026-08-03T00:00:00Z");

  const report = await analyze(f, "clean.ts");
  assert.equal(report.provenance.state, "committed");
  assert.equal(commitId(report), commit);
  assert.equal(report.provenance.targetDirty, false);
  assert.equal(report.location.targetState, "clean");
});

test("a dirty file still attributes an unchanged queried line", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "dirty.ts", "unchanged\nother\n");
  const commit = await commitFixture(f, "dirty: establish file", "2026-08-04T00:00:00Z");
  await writeFixtureFile(f.directory, "dirty.ts", "unchanged\nother locally changed\n");

  const report = await analyze(f, "dirty.ts", 1);
  assert.equal(report.provenance.state, "committed");
  assert.equal(commitId(report), commit);
  assert.equal(report.provenance.targetDirty, true);
  assert.equal(report.location.targetState, "modified");
});

test("a dirty queried line is explicitly uncommitted", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "dirty-line.ts", "original\n");
  await commitFixture(f, "dirty-line: establish file", "2026-08-05T00:00:00Z");
  await writeFixtureFile(f.directory, "dirty-line.ts", "locally edited\n");

  const report = await analyze(f, "dirty-line.ts");
  assert.equal(report.provenance.state, "uncommitted");
  assert.equal(report.provenance.commit, null);
  assert.equal(report.provenance.blame?.uncommitted, true);
  assert.ok(report.provenance.limitations.some((item) => item.includes("uncommitted")));
});

test("an untracked text file is a successful uncommitted analysis", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "baseline.ts", "baseline\n");
  await commitFixture(f, "untracked: establish baseline", "2026-08-05T00:00:00Z");
  await writeFixtureFile(f.directory, "new.ts", "not committed\n");

  const report = await analyze(f, "new.ts");
  assert.equal(report.provenance.state, "uncommitted");
  assert.equal(report.provenance.commit, null);
  assert.equal(report.location.targetState, "untracked");
  assert.equal(report.provenance.blame, null);
});

test("a staged addition without a HEAD version is still uncommitted", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "baseline.ts", "baseline\n");
  await commitFixture(f, "staged: establish baseline", "2026-08-05T01:00:00Z");
  await writeFixtureFile(f.directory, "staged.ts", "staged only\n");
  await gitChecked(f, ["add", "staged.ts"]);

  const report = await analyze(f, "staged.ts");
  assert.equal(report.provenance.state, "uncommitted");
  assert.equal(report.location.targetState, "untracked");
});

test("bare repositories and unborn HEADs are rejected as unsupported inputs", async (t) => {
  const unborn = await fixture(t);
  await writeFixtureFile(unborn.directory, "unborn.ts", "not committed\n");
  await expectExitCode(analyze(unborn, "unborn.ts"), 2, /unborn/);

  const bareParent = await mkdtemp(path.join(os.tmpdir(), "whyline-bare-parent-"));
  t.after(async () => rm(bareParent, { recursive: true, force: true }));
  const bare = path.join(bareParent, "bare.git");
  const initialized = await unborn.runner.run(["init", "--bare", bare], { cwd: bareParent });
  assert.equal(initialized.exitCode, 0, initialized.stderr.toString("utf8"));
  await expectExitCode(
    analyzeLocation("file.ts:1", { currentDirectory: bare, git: unborn.runner }),
    2,
    /bare repositories/,
  );
});

test("invalid, missing, deleted, directory, binary, and outside targets use exit code 2", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "valid.ts", "one\n");
  await writeFixtureFile(f.directory, "directory/placeholder", "x\n");
  await writeFixtureFile(f.directory, "binary.dat", Buffer.from([0x00, 0x01, 0x02]));
  await commitFixture(f, "targets: establish fixture", "2026-08-06T00:00:00Z");

  await expectExitCode(Promise.resolve().then(() => analyzeLocation("valid.ts")), 2, /positive|location/);
  await expectExitCode(analyze(f, "valid.ts", 0), 2, /positive/);
  await expectExitCode(analyze(f, "valid.ts", 2), 2, /beyond/);
  await expectExitCode(analyze(f, "missing.ts"), 2, /exist/);
  await expectExitCode(analyze(f, "directory"), 2, /regular file/);
  await expectExitCode(analyze(f, "binary.dat"), 2, /binary/);
  await expectExitCode(analyze(f, path.join("..", "outside.ts")), 2, /outside/);

  await rm(path.join(f.directory, "valid.ts"));
  await expectExitCode(analyze(f, "valid.ts"), 2, /exist/);
});

test("paths with spaces, Unicode, leading dashes, colons, tabs, and newlines are argv-safe", async (t) => {
  const f = await fixture(t);
  const names = [
    "space name.ts",
    "unicode-λ.ts",
    "-leading.ts",
    "colon:name.ts",
    "tab\tname.ts",
    "line\nname.ts",
  ];
  for (const name of names) await writeFixtureFile(f.directory, name, "line\n");
  await commitFixture(f, "paths: add unusual names", "2026-08-07T00:00:00Z");

  for (const name of names) {
    const report = await analyze(f, name);
    assert.equal(report.provenance.state, "committed", JSON.stringify(name));
    assert.equal(report.location.repositoryPath, name.replaceAll(path.sep, "/"));
    assert.equal(report.provenance.blame?.filename, name);
  }
});

test("a symlink that escapes the selected worktree is rejected", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "baseline.ts", "baseline\n");
  await commitFixture(f, "symlink: establish baseline", "2026-08-08T00:00:00Z");
  const outside = await mkdtemp(path.join(os.tmpdir(), "whyline-outside-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "outside.ts"), "outside\n", "utf8");
  await symlink(path.join(outside, "outside.ts"), path.join(f.directory, "escape.ts"));

  await expectExitCode(analyze(f, "escape.ts"), 2, /outside/);
});

test("pure renames preserve source and destination paths", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "old/name.ts", "keep this line\nsecond\n");
  await commitFixture(f, "rename: establish source", "2026-08-08T00:00:00Z");
  await mkdir(path.join(f.directory, "new"), { recursive: true });
  await gitChecked(f, ["mv", "old/name.ts", "new/name.ts"]);
  const renameCommit = await commitFixture(f, "rename: move file", "2026-08-08T01:00:00Z");

  const report = await analyze(f, "new/name.ts");
  assert.equal(commitId(report), report.provenance.blame?.objectId);
  assert.notEqual(commitId(report), renameCommit);
  assert.equal(report.provenance.blame?.filename, "old/name.ts");
  assert.equal(report.provenance.changedPaths[0]?.kind, "added");
});

test("rename plus modification retains rename-aware evidence and a target hunk", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "before.ts", "keep 1\nkeep 2\nchange me\nkeep 4\n");
  await commitFixture(f, "rename-edit: establish source", "2026-08-09T00:00:00Z");
  await gitChecked(f, ["mv", "before.ts", "after.ts"]);
  await writeFixtureFile(f.directory, "after.ts", "keep 1\nkeep 2\nchanged here\nkeep 4\n");
  const commit = await commitFixture(f, "rename-edit: move and update", "2026-08-09T01:00:00Z");

  const report = await analyze(f, "after.ts", 3);
  assert.equal(commitId(report), commit);
  assert.ok(report.provenance.changedPaths.some((change) => change.kind === "renamed"));
  assert.ok(report.provenance.relevantHunks.length > 0);
  assert.equal(report.provenance.relevantHunks[0]?.targetLineKind, "added");
});

test("line movement remains textual attribution rather than semantic ancestry", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "move.ts", "alpha\nbeta\ngamma\n");
  const root = await commitFixture(f, "move: establish lines", "2026-08-10T00:00:00Z");
  await writeFixtureFile(f.directory, "move.ts", "gamma\nalpha\nbeta\n");
  const moveCommit = await commitFixture(f, "refactor: move line", "2026-08-10T01:00:00Z");

  const report = await analyze(f, "move.ts", 1);
  assert.equal(report.provenance.state, "committed");
  assert.ok([root, moveCommit].includes(commitId(report)));
  assert.ok(report.provenance.limitations.some((item) => item.includes("textual attribution")));
});

test("a merge with an inherited line does not silently choose first-parent history", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "merge.ts", "base\nshared\ntail\n");
  await commitFixture(f, "merge: base", "2026-08-11T00:00:00Z");
  await gitChecked(f, ["switch", "-c", "feature"]);
  await writeFixtureFile(f.directory, "merge.ts", "base\nshared\nfeature line\ntail\n");
  const featureCommit = await commitFixture(f, "merge: feature line", "2026-08-11T01:00:00Z");
  await gitChecked(f, ["switch", "main"]);
  await writeFixtureFile(f.directory, "merge.ts", "main base\nshared\ntail\n");
  await commitFixture(f, "merge: main line", "2026-08-11T02:00:00Z");
  await gitChecked(f, ["merge", "--no-ff", "feature", "-m", "merge: combine branches"]);

  const report = await analyze(f, "merge.ts", 3);
  assert.equal(commitId(report), featureCommit);
  assert.notEqual(report.provenance.parent?.kind, "ambiguous");
});

test("merge resolution either selects blame evidence or reports ambiguity", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "conflict.ts", "same\nbase\n");
  await commitFixture(f, "merge-resolution: base", "2026-08-12T00:00:00Z");
  await gitChecked(f, ["switch", "-c", "resolution-feature"]);
  await writeFixtureFile(f.directory, "conflict.ts", "same\nfeature\n");
  await commitFixture(f, "merge-resolution: feature", "2026-08-12T01:00:00Z");
  await gitChecked(f, ["switch", "main"]);
  await writeFixtureFile(f.directory, "conflict.ts", "same\nmain\n");
  await commitFixture(f, "merge-resolution: main", "2026-08-12T02:00:00Z");
  const conflict = await gitRaw(f, ["merge", "resolution-feature", "-m", "merge: conflict"]);
  assert.notEqual(conflict.exitCode, 0);
  await writeFixtureFile(f.directory, "conflict.ts", "same\nresolved uniquely\n");
  await gitChecked(f, ["add", "conflict.ts"]);
  const mergeCommit = await commitFixture(f, "merge-resolution: resolve", "2026-08-12T03:00:00Z");

  const report = await analyze(f, "conflict.ts", 2);
  assert.equal(commitId(report), mergeCommit);
  if (report.provenance.parent?.kind === "ambiguous") {
    assert.ok(report.provenance.limitations.some((item) => item.includes("ambiguous")));
  } else {
    assert.equal(report.provenance.parent?.kind, "commit");
    assert.ok(report.provenance.parent.commitId.length > 0);
  }
});

test("parent selection is explicitly ambiguous when merge blame has no parent evidence", () => {
  const commit: GitCommit = {
    basis: "fact",
    id: "merge",
    parents: ["parent-a", "parent-b"],
    authorName: "Author",
    authorEmail: "author@example.test",
    authoredAt: "2026-08-12T00:00:00Z",
    committerName: "Committer",
    committerEmail: "committer@example.test",
    committedAt: "2026-08-12T00:00:00Z",
    subject: "merge",
    body: "",
    bodyTruncated: false,
  };
  const blame = parseBlamePorcelain(
    Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1\nauthor A\nauthor-mail <a@example.test>\nauthor-time 1\nauthor-tz +0000\ncommitter C\ncommitter-mail <c@example.test>\ncommitter-time 1\ncommitter-tz +0000\nfilename merge.ts\n\tresolved\n"),
    "merge.ts",
  );
  assert.equal(selectParent(commit, blame).kind, "ambiguous");
});

test("rebased-equivalent and amended commits use the current object identity", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "history.ts", "base\n");
  const root = await commitFixture(f, "history: base", "2026-08-13T00:00:00Z");
  await gitChecked(f, ["switch", "-c", "patch-a"]);
  await writeFixtureFile(f.directory, "history.ts", "equivalent patch\n");
  const patchA = await commitFixture(f, "patch: equivalent A", "2026-08-13T01:00:00Z");
  await gitChecked(f, ["switch", "-c", "patch-b", root]);
  await writeFixtureFile(f.directory, "history.ts", "equivalent patch\n");
  const patchB = await commitFixture(f, "patch: equivalent B", "2026-08-13T02:00:00Z");
  assert.notEqual(patchA, patchB);

  const rebased = await analyze(f, "history.ts");
  assert.equal(commitId(rebased), patchB);
  await writeFixtureFile(f.directory, "history.ts", "amended patch\n");
  const amendedBefore = await gitChecked(f, ["rev-parse", "HEAD"]);
  await gitChecked(f, ["add", "history.ts"]);
  await gitChecked(f, ["commit", "--amend", "--no-edit", "--no-verify"], { GIT_AUTHOR_DATE: "2026-08-13T03:00:00Z", GIT_COMMITTER_DATE: "2026-08-13T03:00:00Z" });
  const amended = (await gitChecked(f, ["rev-parse", "HEAD"])).toString("utf8").trim();
  assert.notEqual(amended, amendedBefore.toString("utf8").trim());
  assert.equal(commitId(await analyze(f, "history.ts")), amended);
});

test("linked worktrees and detached HEAD are represented in repository context", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "worktree.ts", "linked\n");
  const commit = await commitFixture(f, "worktree: add line", "2026-08-14T00:00:00Z");
  const parent = await mkdtemp(path.join(os.tmpdir(), "whyline-linked-parent-"));
  const linked = path.join(parent, "linked");
  t.after(async () => rm(parent, { recursive: true, force: true }));
  await gitChecked(f, ["worktree", "add", "--detach", linked, commit]);

  const linkedReport = await analyze(f, path.join(linked, "worktree.ts"), 1, { currentDirectory: linked });
  assert.equal(linkedReport.repository.worktreeRoot, linked);
  assert.notEqual(linkedReport.repository.gitDir, linkedReport.repository.commonGitDir);
  assert.ok(linkedReport.repository.worktrees.length >= 2);
  assert.equal(linkedReport.repository.branch, null);
  await gitChecked(f, ["worktree", "remove", "--force", linked]);
});

test("shallow history returns commit facts with an explicit incomplete-history limitation", async (t) => {
  const source = await fixture(t);
  await writeFixtureFile(source.directory, "shallow.ts", "first\nsecond\n");
  await commitFixture(source, "shallow: base", "2026-08-15T00:00:00Z");
  await writeFixtureFile(source.directory, "shallow.ts", "first\nsecond changed\n");
  const sourceHead = await commitFixture(source, "shallow: later edit", "2026-08-15T01:00:00Z");
  const cloneParent = await mkdtemp(path.join(os.tmpdir(), "whyline-shallow-parent-"));
  const clone = path.join(cloneParent, "clone");
  t.after(async () => rm(cloneParent, { recursive: true, force: true }));
  const cloned = await source.runner.run(["clone", "--depth=1", `file://${source.directory}`, clone], { cwd: cloneParent });
  assert.equal(cloned.exitCode, 0, cloned.stderr.toString("utf8"));
  const cloneFixture: Fixture = {
    directory: clone,
    globalConfig: source.globalConfig,
    environment: source.environment,
    runner: new GitProcess({ environment: source.environment }),
  };

  const report = await analyze(cloneFixture, "shallow.ts", 2);
  assert.equal(commitId(report), sourceHead);
  assert.ok(report.provenance.limitations.some((item) => /shallow|incomplete|unavailable/.test(item)));
});

test("SHA-256 repositories retain the reported object format and full IDs", async (t) => {
  const f = await fixture(t, "sha256").catch((error: unknown) => {
    t.skip(`SHA-256 Git repository unsupported: ${error instanceof Error ? error.message : "unknown"}`);
    return null;
  });
  if (f === null) return;
  await writeFixtureFile(f.directory, "sha256.ts", "format\n");
  const commit = await commitFixture(f, "sha256: add file", "2026-08-16T00:00:00Z");
  const report = await analyze(f, "sha256.ts");
  assert.equal(report.repository.objectFormat, "sha256");
  assert.equal(commitId(report), commit);
  assert.ok(commit.length > 40);
});

test("mutation between analysis stages produces exit code 3", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "mutate.ts", "stable\n");
  await commitFixture(f, "mutation: establish file", "2026-08-17T00:00:00Z");

  await expectExitCode(
    analyze(f, "mutate.ts", 1, {
      hooks: {
        beforeFinalVerification: async (report) => {
          await writeFile(report.location.absolutePath, "changed while analyzing\n", "utf8");
        },
      },
    }),
    3,
    /changed during analysis/,
  );
});

test("argv-only Git execution cannot interpolate a hostile path", async (t) => {
  const f = await fixture(t);
  const hostileName = "$(touch marker).ts";
  const marker = path.join(f.directory, "marker");
  await writeFixtureFile(f.directory, hostileName, "safe\n");
  await commitFixture(f, "argv: add hostile path", "2026-08-18T00:00:00Z");

  const report = await analyze(f, hostileName);
  assert.equal(report.location.repositoryPath, hostileName);
  await assert.rejects(readFile(marker));
});

class RecordingRunner implements GitRunner {
  public readonly calls: string[][] = [];

  public constructor(private readonly inner: GitRunner) {}

  public run(args: readonly string[], options: { readonly cwd: string; readonly input?: Uint8Array }) {
    this.calls.push([...args]);
    return this.inner.run(args, options);
  }
}

test("the provenance pipeline uses only bounded read-only Git command families", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "audit.ts", "audit\n");
  await commitFixture(f, "audit: add target", "2026-08-19T00:00:00Z");
  const recorder = new RecordingRunner(f.runner);
  const report = await analyze(f, "audit.ts", 1, { git: recorder });
  assert.equal(report.provenance.state, "committed");
  const joined = recorder.calls.flat();
  for (const forbidden of ["fetch", "push", "pull", "commit", "add", "reset", "checkout", "merge"]) {
    assert.equal(joined.includes(forbidden), false, `unexpected mutating command ${forbidden}`);
  }
  const allowed = new Set([
    "rev-parse",
    "symbolic-ref",
    "worktree",
    "status",
    "ls-files",
    "ls-tree",
    "blame",
    "merge-base",
    "show",
    "cat-file",
    "diff-tree",
    "hash-object",
    "diff",
  ]);
  for (const args of recorder.calls) {
    const command = args[0] === "-c"
      ? args.find((argument, index) => index > 0 && allowed.has(argument))
      : args[0];
    assert.ok(command !== undefined && allowed.has(command), `unexpected Git command ${command ?? "(none)"}`);
  }
  assert.ok(recorder.calls.some((args) => args.includes("blame") && args.includes("--")));
  assert.ok(recorder.calls.some((args) => args.includes("status") && args.includes("--")));
  assert.ok(recorder.calls.some((args) => args.includes("diff") && args.includes("--")));
});

test("malformed CLI input is rejected before repository analysis", () => {
  for (const input of ["file.ts", "file.ts:", "file.ts:0", "file.ts:-1", "file.ts:x", "file.ts:1:2"]) {
    if (input === "file.ts:1:2") {
      assert.deepEqual(parseLocation(input), { input, file: "file.ts:1", line: 2 });
    } else {
      assert.throws(() => parseLocation(input), InvalidInputError);
    }
  }
});

test("representative CLI output is deterministic and control-character-free", async (t) => {
  const f = await fixture(t);
  await writeFixtureFile(f.directory, "cli.ts", "line\n");
  await commitFixture(f, "cli: report\u001b[31m", "2026-08-20T00:00:00Z");
  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const result = await execFileAsync(process.execPath, [cliPath, "cli.ts:1"], {
    cwd: f.directory,
    env: f.environment,
    maxBuffer: 256 * 1024,
  });
  assert.match(result.stdout, /Explanation/);
  assert.match(result.stdout, /Textual last-touch/);
  assert.match(result.stdout, /Git ancestry/);
  assert.doesNotMatch(result.stdout, /Relevant change/);
  assert.doesNotMatch(result.stdout, /\u001b/);
  assert.doesNotMatch(result.stderr, /\u001b/);
});

test("the CLI honors CODEX_HOME without consulting the ambient home profile", async (t) => {
  const f = await fixture(t);
  const firstLine = "const cliHomeFirst = \"target-alpha\";";
  const secondLine = "const cliHomeSecond = \"target-beta\";";
  await writeFixtureFile(f.directory, "cli.ts", `${firstLine}\n${secondLine}\n`);
  const commit = await commitFixture(f, "cli: use synthetic Codex home", "2026-08-08T01:00:00Z");

  const ambientHome = await mkdtemp(path.join(os.tmpdir(), "whyline-cli-ambient-home-"));
  t.after(async () => rm(ambientHome, { recursive: true, force: true }));
  await writeCodexPatchTranscript(
    f.environment.CODEX_HOME as string,
    "synthetic-home-marker",
    f.directory,
    commit,
  );
  await writeCodexPatchTranscript(
    path.join(ambientHome, ".codex"),
    "ambient-profile-marker",
    f.directory,
    commit,
  );

  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  const result = await execFileAsync(process.execPath, [cliPath, "cli.ts:1"], {
    cwd: f.directory,
    env: { ...f.environment, HOME: ambientHome, FORCE_COLOR: "0" },
    maxBuffer: 256 * 1024,
  });
  assert.match(result.stdout, /AI provenance: likely Codex session synthetic-home-marker/);
  assert.doesNotMatch(result.stdout, /ambient-profile-marker/);
});

test("the CLI maps malformed input to exit code 2", async (t) => {
  const f = await fixture(t);
  const cliPath = path.resolve(process.cwd(), "dist/src/cli/main.js");
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "missing-line"], {
      cwd: f.directory,
      env: f.environment,
      maxBuffer: 64 * 1024,
    }),
    (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error)) return false;
      return (error as Error & { readonly code?: unknown }).code === 2;
    },
  );
});

test("porcelain parsers preserve NUL-safe renames and hunk line kinds", () => {
  const names = Buffer.from("R87\u0000old name.ts\u0000new name.ts\u0000M\u0000same.ts\u0000", "utf8");
  const parsed = parseNameStatus(names);
  assert.deepEqual(parsed[0], {
    basis: "derived",
    kind: "renamed",
    oldPath: "old name.ts",
    newPath: "new name.ts",
    similarity: 87,
  });
  assert.equal(parsed[1]?.kind, "modified");

  const diff = Buffer.from("diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,3 @@\n old\n-new\n+new\n+added\n", "utf8");
  const hunks = parseUnifiedDiff(diff, 3);
  assert.equal(hunks[0]?.targetLineKind, "added");
  assert.equal(hunks[0]?.lines.filter((line) => line.kind === "added").length, 2);
});

test("blame porcelain captures previous path, metadata, and all-zero attribution", () => {
  const attribution = parseBlamePorcelain(
    Buffer.from("0000000000000000000000000000000000000000 7 7\nauthor Local\nauthor-mail <local@example.test>\nauthor-time 1\nauthor-tz +0000\ncommitter Local\ncommitter-mail <local@example.test>\ncommitter-time 1\ncommitter-tz +0000\nfilename path with spaces.ts\n\tlocal line\n", "utf8"),
    "fallback.ts",
  );
  assert.equal(attribution.uncommitted, true);
  assert.equal(attribution.filename, "path with spaces.ts");
  assert.equal(attribution.finalLine, 7);
  assert.equal(attribution.lineContent, "local line");
});
