import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPackageEntries,
  type PackageArchiveEntry,
} from "../src/release/package-surface.js";
import {
  assertTagMatchesVersion,
  versionFromReleaseTag,
} from "../src/release/tag-version.js";

function file(path: string): PackageArchiveEntry {
  return { path: `package/${path}`, kind: "file" };
}

test("accepts the structurally bounded public package surface", () => {
  assert.doesNotThrow(() => assertPackageEntries([
    file("package.json"),
    file("README.md"),
    file("LICENSE"),
    file("dist/src/cli/main.js"),
    file("dist/src/release/package-surface.js"),
  ]));
});

test("rejects development and non-runtime material in the package", () => {
  assert.throws(
    () => assertPackageEntries([
      file("package.json"),
      file("README.md"),
      file("LICENSE"),
      file("dist/src/cli/main.js"),
      file("src/cli/main.ts"),
    ]),
    /disallowed package path.*package\/src\/cli\/main\.ts/,
  );
});

test("requires the manifest, public docs, and compiled runtime", () => {
  assert.throws(
    () => assertPackageEntries([file("package.json"), file("README.md")]),
    /missing required package path.*LICENSE/,
  );
  assert.throws(
    () => assertPackageEntries([
      file("package.json"),
      file("README.md"),
      file("LICENSE"),
    ]),
    /missing required package path.*(?:compiled runtime|dist\/src\/cli\/main\.js)/,
  );
});

test("rejects source maps, test output, and unsafe archive paths", () => {
  for (const path of [
    "dist/src/cli/main.js.map",
    "dist/test/cli.test.js",
    "docs/validation/example.md",
    "package/../outside.js",
  ]) {
    assert.throws(
      () => assertPackageEntries([
        file("package.json"),
        file("README.md"),
        file("LICENSE"),
        file("dist/src/cli/main.js"),
        { path: path.startsWith("package/") ? path : `package/${path}`, kind: "file" },
      ]),
      /disallowed package path/,
      path,
    );
  }
});

test("rejects non-regular tar entry types even at allowed paths", () => {
  assert.throws(
    () => assertPackageEntries([
      file("package.json"),
      file("README.md"),
      file("LICENSE"),
      file("dist/src/cli/main.js"),
      { path: "package/dist/src/cli/linked.js", kind: "other" },
    ]),
    /disallowed package path.*package\/dist\/src\/cli\/linked\.js/,
  );
});

test("accepts only exact vX.Y.Z release tags", () => {
  assert.equal(versionFromReleaseTag("v0.1.1"), "0.1.1");
  assert.throws(() => versionFromReleaseTag("0.1"), /release tag must match/);
  assert.throws(() => versionFromReleaseTag("v0.1.1-rc.1"), /release tag must match/);
});

test("rejects a tag whose version differs from package.json", () => {
  assert.doesNotThrow(() => assertTagMatchesVersion("v0.1.1", "0.1.1"));
  assert.throws(
    () => assertTagMatchesVersion("v0.1.1", "0.1.0"),
    /does not match package\.json version/,
  );
});
