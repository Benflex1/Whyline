import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly license?: string;
  readonly author?: string;
  readonly repository?: { readonly type?: string; readonly url?: string };
  readonly bugs?: { readonly url?: string };
  readonly homepage?: string;
  readonly keywords?: readonly string[];
  readonly files?: readonly string[];
  readonly bin?: { readonly whyline?: string };
  readonly engines?: { readonly node?: string };
}

async function readPackageManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as PackageManifest;
}

test("package manifest exposes the approved public release metadata", async () => {
  const manifest = await readPackageManifest();

  assert.equal(manifest.name, "whyline");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.private, undefined);
  assert.match(manifest.description ?? "", /why does this line exist/i);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.author, "Benflex1");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/Benflex1/Whyline.git",
  });
  assert.deepEqual(manifest.bugs, { url: "https://github.com/Benflex1/Whyline/issues" });
  assert.equal(manifest.homepage, "https://github.com/Benflex1/Whyline#readme");
  assert.deepEqual(manifest.files, ["dist/src/**/*.js", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.bin, { whyline: "dist/src/cli/main.js" });
  assert.deepEqual(manifest.engines, { node: ">=24" });
  assert.ok(manifest.keywords?.includes("provenance"));
  assert.ok(manifest.keywords?.includes("codex"));
});

test("npm dry-run package contents are compiled runtime files and public docs only", async () => {
  const result = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    maxBuffer: 256 * 1024,
  });
  const packs = JSON.parse(result.stdout) as Array<{ readonly files?: Array<{ readonly path?: string }> }>;
  const files = (packs[0]?.files ?? []).map((file) => file.path ?? "");

  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("LICENSE"));
  assert.ok(files.includes("dist/src/cli/main.js"));
  assert.ok(files.every((file) => file === "package.json"
    || file === "README.md"
    || file === "LICENSE"
    || file.startsWith("dist/src/") && file.endsWith(".js")));
  assert.ok(!files.includes("package-lock.json"));
  assert.ok(!files.some((file) => file.startsWith("src/") || file.startsWith("test/") || file.endsWith(".map")));
});
