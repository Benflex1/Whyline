const RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

export function versionFromReleaseTag(tag: string): string {
  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (match === null) {
    throw new Error(`release tag must match vX.Y.Z exactly: ${tag}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function assertTagMatchesVersion(tag: string, packageVersion: string): void {
  const tagVersion = versionFromReleaseTag(tag);
  if (tagVersion !== packageVersion) {
    throw new Error(`release tag ${tag} does not match package.json version ${packageVersion}`);
  }
}
