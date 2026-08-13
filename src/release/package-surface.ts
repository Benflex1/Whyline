export interface PackageArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

const REQUIRED_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/src/cli/main.js",
] as const;

function isSafePath(value: string): boolean {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return (normalized === "package" || normalized.startsWith("package/"))
    && !normalized.includes("\\")
    && !normalized.includes("\u0000")
    && !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isAllowedEntry(entry: PackageArchiveEntry): boolean {
  if (!isSafePath(entry.path)) return false;
  if (entry.kind === "directory") {
    const normalized = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
    return normalized === "package"
      || normalized.startsWith("package/dist/src/");
  }
  return entry.path === "package/package.json"
    || entry.path === "package/README.md"
    || entry.path === "package/LICENSE"
    || /^package\/dist\/src\/[^/]+(?:\/[^/]+)*\.js$/.test(entry.path);
}

export function assertPackageEntries(entries: readonly PackageArchiveEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`duplicate package path: ${entry.path}`);
    }
    seen.add(entry.path);
    if (!isAllowedEntry(entry)) {
      throw new Error(`disallowed package path: ${entry.path}`);
    }
  }

  for (const required of REQUIRED_FILES) {
    if (!seen.has(required)) {
      throw new Error(`missing required package path: ${required}`);
    }
  }
}
