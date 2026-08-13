import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  let tag;
  let requireTag = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tag") {
      tag = argv[index + 1];
      index += 1;
      if (tag === undefined || tag.length === 0) throw new Error("--tag requires a value");
    } else if (argument === "--require-tag") {
      requireTag = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { tag, requireTag };
}

async function git(args) {
  try {
    return (await execFileAsync("git", args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        LANG: "C",
      },
      maxBuffer: 64 * 1024,
    })).stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown Git error";
    throw new Error(`Git release identity check failed: ${detail}`, { cause: error });
  }
}

async function main() {
  const { tag, requireTag } = parseArguments(process.argv.slice(2));
  if (tag === undefined) {
    if (requireTag) throw new Error("a release tag is required");
    console.log("release preflight: non-tag dry run; tag/version check skipped");
    return;
  }

  const packageManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const { assertTagMatchesVersion } = await import(
    pathToFileURL(path.join(repositoryRoot, "dist/src/release/tag-version.js")).href,
  );
  assertTagMatchesVersion(tag, packageManifest.version);

  const tagCommit = await git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  const headCommit = await git(["rev-parse", "HEAD"]);
  if (tagCommit !== headCommit) {
    throw new Error(`checked-out HEAD ${headCommit} does not match release tag ${tag} at ${tagCommit}`);
  }
  console.log(`release preflight: ${tag} matches package.json ${packageManifest.version} at ${headCommit}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
