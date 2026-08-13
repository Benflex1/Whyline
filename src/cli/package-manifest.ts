import { readFile } from "node:fs/promises";

interface PackageManifest {
  readonly version?: unknown;
}

function isPackageManifest(value: unknown): value is PackageManifest {
  return typeof value === "object" && value !== null;
}

export async function readPackageVersion(): Promise<string> {
  const manifestText = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
  const manifest: unknown = JSON.parse(manifestText);
  if (!isPackageManifest(manifest) || typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("package manifest does not contain a version");
  }
  return manifest.version;
}
