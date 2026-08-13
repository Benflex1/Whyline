# Releasing Whyline

M2 provides a non-publishing dry run:

```sh
npm run release:dry-run
```

The release workflow checks out the tag ref, verifies that `package.json` is the version source of truth, runs the normal checks, creates and accepts one npm tarball, and uploads that exact `.tgz`. It records the validated commit and tarball SHA-256; the publication job checks out that commit, rechecks that the tag still resolves to it, verifies the downloaded checksum, and publishes the downloaded file. It does not build or pack again.

The separate compatibility job builds Git `2.36.6` from upstream commit `ecaa3db17183b4a3895ccd0c0c1af01d0e6fed45` (SHA-256 `40308ff4416d2c4be7bb1dfa86094140dd693e22287e4f53347ca7d87952f7c9`), places that executable first on `PATH`, and runs the installed package acceptance. This exercises Whyline's repository discovery, machine-readable status/worktree mapping, blame, commit/diff, tree/blob, and linked-worktree paths rather than only checking the version string.

Before M3, configure a GitHub Actions environment named `release` with required reviewers and tag restrictions. For the first public publication, add a granular npm publication token with the required 2FA bypass as the environment secret `NPM_TOKEN`. The workflow fails before `npm publish` if neither that secret nor the trusted-publisher mode variable is configured.

After `whyline@0.1.0` exists, npm trusted publishing can replace the bootstrap token. Configure the npm trusted publisher for `Benflex1/Whyline`, workflow filename `release.yml`, and environment `release`, then set the environment variable `NPM_TRUSTED_PUBLISHER=true` and remove `NPM_TOKEN` when ready. The release job already grants only that job `id-token: write` and publishes with `--provenance`; normal CI has no token or OIDC permission.

If npm publication succeeds but GitHub Release creation fails, do not rerun the publishing path: an npm name/version is immutable. Dispatch `release.yml` with the same existing tag and `release_only=true`; that mode retests the exact tag and package, skips npm publication, and runs a separate GitHub-Release-only job with `contents: write` but no OIDC permission. Use `gh release edit` if the release already exists and only its notes need correction.

The GitHub Release uses GitHub-generated concise notes. No version mutation, release commit, changelog automation, tag creation, npm publication, or GitHub Release creation is performed by M2.
