# Release guide

This project publishes stable releases from Windows GitHub Actions. The current
release is `0.4.5`; use the same checklist for later versions.

## One-time setup

- The public repository is `keaipiao/codex-quota` and the npm package is
  `@elonmark/codex-quota`.
- npm Trusted Publishing must authorize repository `keaipiao/codex-quota`,
  workflow `release.yml`, and the `npm publish` permission. No npm environment
  restriction is used unless the workflow is changed to name the same GitHub
  environment.
- Repository Actions variable `PUBLISH_NPM` must equal `true` to publish npm.
  When it is absent or different, the workflow still publishes GitHub Release
  assets.
- No long-lived `NPM_TOKEN` is required or consumed. The npm job uses GitHub
  OIDC and npm 11.5.1 or newer.
- Enable Private Vulnerability Reporting and protect the default branch with
  the Windows CI checks before accepting outside contributions. Add a `v*` tag
  ruleset that restricts creation, update, and deletion of release tags.
- Enable GitHub Immutable Releases for the repository. The workflow prepares a
  draft with every asset before publication and fails if the published release
  is not immutable.

See the official [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/)
when changing publisher settings.

## Prepare

Run these steps from a clean Windows checkout on the default branch.

1. Choose a stable `MAJOR.MINOR.PATCH` version. Prerelease versions are not
   accepted by the release workflow.
2. Update `package.json` and `package-lock.json` without creating a tag:

   ```powershell
   $version = "<next-version>"
   npm.cmd version $version --no-git-tag-version
   ```

3. Add the dated `CHANGELOG.md` entry and update both READMEs when commands or
   behavior changed.
4. Confirm the public contract in `package.json`: exact package name
   `@elonmark/codex-quota`, sole executable `codex-quota` pointing to
   `bin/codex-quota.mjs`, public npm registry, Windows x64 support, and the
   `keaipiao/codex-quota` repository.
5. Run all local gates:

   ```powershell
   npm.cmd ci --ignore-scripts --no-audit --no-fund
   npm.cmd run check
   npm.cmd test
   npm.cmd pack --dry-run --ignore-scripts
   ```

6. Build and inspect an archive if desired:

   ```powershell
   $pack = npm.cmd pack --ignore-scripts --json | ConvertFrom-Json
   $archive = $pack[0].filename
   tar.exe -tf $archive
   (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
   ```

   It must contain no credentials, caches, logs, tests, or development files.
   Remove the local archive after inspection; the tag workflow builds a fresh
   verified artifact.
7. Commit and push the release changes. Wait for the Node.js 22 and 24 Windows
   CI jobs to pass on the default branch.

## Tag and publish

Only tag the tested commit on the default branch:

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
git pull --ff-only
git tag -a "v$version" -m "Codex Quota $version"
git push origin "v$version"
```

The release workflow then:

1. verifies the stable tag/version and exact package contract;
2. verifies that the tagged commit is contained in the repository's default
   branch;
3. runs syntax checks and the full test suite with the pinned Node.js 24.18.0
   and npm 11.16.0 release toolchain;
4. creates one npm archive and a SHA-256 checksum;
5. creates or reconciles a draft GitHub Release and verifies its exact asset
   set before any npm change;
6. publishes that exact archive to npm through OIDC when enabled, then verifies
   SHA-1, SHA-512 integrity, `latest`, and provenance;
7. publishes the prepared GitHub Release without overwriting an existing
   asset.

Reruns are safe: all release tags are serialized, the release toolchain is
pinned, an npm version is accepted only when its registry hashes and provenance
are complete and `latest` is the same or a newer stable version, and the GitHub
Release must have exactly the expected assets with matching SHA-256 hashes. An
older missing npm version is never backfilled after a newer `latest`. Existing
published GitHub Releases are audited without changing Latest. Any mismatch
stops before npm publication. Never move or reuse a public tag; publish a new
patch for a defect.

## Verify

1. Confirm the GitHub Release has both the `.tgz` and `.sha256` assets and that
   the checksum passes.
2. Confirm npm `latest`, package version, executable mapping, provenance, and
   tarball SHA-1 match the release artifact.
3. From the default PowerShell directory on Windows 11 x64 with Node.js 22+:

   ```powershell
   npx.cmd --yes @elonmark/codex-quota@<version> version
   npx.cmd --yes @elonmark/codex-quota@<version> install
   npx.cmd --yes @elonmark/codex-quota@<version> doctor
   ```

4. Fully exit the Store app and open **Codex + Quota**. Check the panel,
   refresh, scrolling, account-menu clearance, locale behavior, update from the
   previous release, and uninstall.
5. Review `doctor --live` before sharing it; remove usernames, full paths, PIDs,
   and other identifiers.
