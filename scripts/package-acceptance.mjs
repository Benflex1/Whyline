import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPath = path.join(repositoryRoot, "package.json");

function parseArguments(argv) {
  let artifactDirectory;
  let expectedGitVersion;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact-dir") {
      artifactDirectory = argv[index + 1];
      index += 1;
      if (artifactDirectory === undefined || artifactDirectory.length === 0) {
        throw new Error("--artifact-dir requires a path");
      }
    } else if (argument === "--expected-git-version") {
      expectedGitVersion = argv[index + 1];
      index += 1;
      if (expectedGitVersion === undefined || expectedGitVersion.length === 0) {
        throw new Error("--expected-git-version requires a version");
      }
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { artifactDirectory, expectedGitVersion };
}

function commandFailure(command, error) {
  if (!(error instanceof Error)) return new Error(`${command} failed`);
  const details = [
    error.message,
    typeof error.stdout === "string" ? error.stdout.trim() : "",
    typeof error.stderr === "string" ? error.stderr.trim() : "",
  ].filter((value) => value.length > 0).join("\n");
  return new Error(`${command} failed:\n${details}`, { cause: error });
}

async function run(command, args, options = {}) {
  const environment = {
    ...process.env,
    CI: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    LC_ALL: "C",
    LANG: "C",
    ...options.env,
  };
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: environment,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    });
  } catch (error) {
    throw commandFailure([command, ...args].join(" "), error);
  }
}

async function sha256(filePath) {
  const digest = createHash("sha256");
  digest.update(await readFile(filePath));
  return digest.digest("hex");
}

function parsePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new Error("npm pack returned unexpected JSON");
  }
  const result = parsed[0];
  if (typeof result.filename !== "string" || !result.filename.endsWith(".tgz")) {
    throw new Error("npm pack did not report a .tgz filename");
  }
  return result;
}

async function readArchiveEntries(tarballPath) {
  const result = await run("tar", ["-tvzf", tarballPath]);
  return result.stdout
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const pathStart = entry.indexOf("package/");
      const pathValue = pathStart < 0 ? entry : entry.slice(pathStart);
      const type = entry[0];
      return {
        path: pathValue,
        kind: type === "d"
          ? "directory"
          : type === "-"
            ? "file"
            : "other",
      };
    });
}

async function readArchiveManifest(tarballPath) {
  const result = await run("tar", ["-xOf", tarballPath, "package/package.json"]);
  const manifest = JSON.parse(result.stdout);
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("package archive manifest is not an object");
  }
  return manifest;
}

async function createFixture(root, environment) {
  const fixture = path.join(root, "fixture");
  const linked = path.join(root, "linked-worktree");
  const codexHome = path.join(root, "codex-home");
  const emptyGitConfig = path.join(root, "empty-gitconfig");
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(emptyGitConfig, "", "utf8");
  const gitEnvironment = {
    ...environment,
    CODEX_HOME: codexHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };

  await run("git", ["init", "-q"], { cwd: fixture, env: gitEnvironment });
  await run("git", ["config", "user.name", "Whyline Package Acceptance"], { cwd: fixture, env: gitEnvironment });
  await run("git", ["config", "user.email", "package-acceptance@example.test"], { cwd: fixture, env: gitEnvironment });
  await run("git", ["config", "commit.gpgSign", "false"], { cwd: fixture, env: gitEnvironment });
  await writeFile(
    path.join(fixture, "src", "fixture.ts"),
    "export const packageAcceptanceIntro = \"intro\";\n"
      + "export const packageAcceptanceAnchor = \"a sufficiently distinctive committed line\";\n"
      + "export const packageAcceptanceOutro = \"outro\";\n",
    "utf8",
  );
  await run("git", ["add", "--", "src/fixture.ts"], { cwd: fixture, env: gitEnvironment });
  await run("git", ["commit", "--no-verify", "-m", "package acceptance fixture"], { cwd: fixture, env: gitEnvironment });
  await run("git", ["worktree", "add", "--detach", linked, "HEAD"], { cwd: fixture, env: gitEnvironment });
  return { fixture, linked, gitEnvironment };
}

async function runInstalledBin(prefix, args, cwd, environment) {
  return run(
    "npm",
    ["--prefix", prefix, "exec", "--offline", "--", "whyline", ...args],
    { cwd, env: environment },
  );
}

async function main() {
  const { artifactDirectory, expectedGitVersion } = parseArguments(process.argv.slice(2));
  const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "whyline-package-acceptance-"));
  const packDirectory = path.join(tempRoot, "pack");
  const prefix = path.join(tempRoot, "prefix");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(prefix, { recursive: true });
  const environment = {
    ...process.env,
    CODEX_HOME: path.join(tempRoot, "codex-home"),
  };

  try {
    await run("npm", ["run", "build"], { cwd: repositoryRoot, env: environment });
    const packResult = parsePackResult((await run(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      { cwd: repositoryRoot, env: environment },
    )).stdout);
    const tarballPath = path.join(packDirectory, path.basename(packResult.filename));
    const archiveEntries = await readArchiveEntries(tarballPath);
    const { assertPackageEntries } = await import(
      pathToFileURL(path.join(repositoryRoot, "dist/src/release/package-surface.js")).href,
    );
    assertPackageEntries(archiveEntries);
    const archiveManifest = await readArchiveManifest(tarballPath);
    if (archiveManifest.name !== packageManifest.name || archiveManifest.version !== packageManifest.version) {
      throw new Error("package archive manifest does not match the checked-out package.json");
    }

    await run("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--prefix",
      prefix,
      tarballPath,
    ], { cwd: tempRoot, env: environment });

    const fixture = await createFixture(tempRoot, environment);
    const help = await runInstalledBin(prefix, ["--help"], fixture.fixture, fixture.gitEnvironment);
    if (help.stderr.length !== 0 || !/^Usage:/m.test(help.stdout) || !/--version/.test(help.stdout)) {
      throw new Error(`installed whyline --help did not expose the expected usage surface: stdout=${JSON.stringify(help.stdout)} stderr=${JSON.stringify(help.stderr)}`);
    }

    const version = await runInstalledBin(prefix, ["--version"], fixture.fixture, fixture.gitEnvironment);
    if (version.stderr.length !== 0 || version.stdout !== `${packageManifest.version}\n`) {
      throw new Error(`installed whyline --version returned ${JSON.stringify(version.stdout)}`);
    }

    const query = await runInstalledBin(prefix, ["src/fixture.ts:2"], fixture.fixture, fixture.gitEnvironment);
    if (query.stderr.length !== 0 || !/Explanation/.test(query.stdout) || !/Textual last-touch:/.test(query.stdout)) {
      throw new Error("installed whyline basic Git query did not return the expected explanation");
    }

    const linkedQuery = await runInstalledBin(prefix, ["src/fixture.ts:2"], fixture.linked, fixture.gitEnvironment);
    if (linkedQuery.stderr.length !== 0 || !/Explanation/.test(linkedQuery.stdout)) {
      throw new Error("installed whyline linked-worktree query did not return an explanation");
    }

    const gitVersion = (await run("git", ["--version"], { cwd: fixture.fixture, env: fixture.gitEnvironment })).stdout.trim();
    if (expectedGitVersion !== undefined && gitVersion !== `git version ${expectedGitVersion}`) {
      throw new Error(`expected Git ${expectedGitVersion}, resolved ${gitVersion}`);
    }

    let retainedTarballPath;
    if (artifactDirectory !== undefined) {
      const destination = path.resolve(artifactDirectory);
      await mkdir(destination, { recursive: true });
      retainedTarballPath = path.join(destination, path.basename(tarballPath));
      await copyFile(tarballPath, retainedTarballPath);
      if (await sha256(tarballPath) !== await sha256(retainedTarballPath)) {
        throw new Error("retained release artifact differs from the tested tarball");
      }
    }

    const sizeBytes = (await stat(tarballPath)).size;
    console.log(`package acceptance: ${archiveEntries.filter((entry) => entry.kind === "file").length} files`);
    console.log(`package acceptance: tarball ${path.basename(tarballPath)} (${sizeBytes} bytes, ${packResult.unpackedSize ?? "unknown"} unpacked bytes)`);
    console.log(`package acceptance: installed bin help/version/query/linked-worktree passed`);
    console.log(`package acceptance: ${gitVersion}`);
    if (retainedTarballPath !== undefined) console.log(`package acceptance: retained ${retainedTarballPath}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
