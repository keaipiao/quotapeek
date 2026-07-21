# Release guide

This checklist prepares the first public `0.2.0` release and subsequent
releases. Run release commands from PowerShell on a clean Windows checkout.

## One-time repository setup

- [ ] Create the public `keaipiao/quotapeek` GitHub repository without asking
      GitHub to generate another README, license, or `.gitignore`.
- [ ] Set `https://github.com/keaipiao/quotapeek.git` as `origin`, push the
      default branch, and verify `git remote -v` before adding a release tag.
- [ ] Confirm `repository`, `homepage`, and `bugs` in `package.json` point to
      `keaipiao/quotapeek`.
- [ ] Confirm the unscoped npm name `quotapeek` is available and owned by the
      intended npm maintainer before the first publish.
- [ ] Confirm the package `author`/maintainer metadata and public contact policy.
- [ ] Enable GitHub Private Vulnerability Reporting under repository security
      settings.
- [ ] Enable branch protection/rulesets requiring the Windows CI checks.
- [ ] If the package already exists on npm, configure a GitHub Actions Trusted
      Publisher for the exact GitHub owner and repository. Enter the workflow
      filename `release.yml` (not its full path), allow `npm publish`, and use
      an npm environment restriction only if the workflow is updated to name
      the same GitHub environment.
- [ ] Create the repository Actions variable `PUBLISH_NPM` with value `true`
      only after npm Trusted Publishing is ready. Leave it absent or `false` to
      publish GitHub Releases without publishing to npm.
- [ ] Review GitHub Actions settings and allow only the pinned actions used by
      this repository.

The release workflow uses OIDC Trusted Publishing and does not require or
consume a long-lived `NPM_TOKEN` secret.

### Bootstrap a brand-new npm package

npm requires a package to exist before a Trusted Publisher can be attached to
it. If `quotapeek` has never been published:

1. Leave `PUBLISH_NPM` absent or `false` and publish the first GitHub Release.
2. Download its `.tgz` and `.sha256` assets and verify the checksum.
3. Sign in to npm interactively with a maintainer account protected by 2FA.
4. Publish that exact downloaded archive rather than repacking the checkout:

   ```powershell
   npm.cmd publish .\quotapeek-0.2.0.tgz --access public --provenance=false
   ```

   The one-time `--provenance=false` overrides the package default because a
   local terminal cannot create GitHub Actions provenance. Do not introduce a
   long-lived automation token for this bootstrap.
5. Configure the npm Trusted Publisher as described above, then set
   `PUBLISH_NPM=true` for future patch releases. Trusted Publishing requires
   npm 11.5.1 or newer; the workflow checks this before publishing.

See the official [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/)
before enabling the variable, because npm's publisher settings and requirements
can change independently of this project.

## Prepare a release

1. Choose the version. For the first public release, it is `0.2.0`.
2. Update the version in `package.json` without creating a tag yet:

   ```powershell
   npm.cmd version 0.2.0 --no-git-tag-version --allow-same-version
   ```

3. Change the matching `CHANGELOG.md` heading from `Unreleased` to the release
   date (`YYYY-MM-DD`). Ensure both READMEs describe the actual behavior.
4. Confirm `LICENSE`, `SECURITY.md`, supported platforms, and all CLI examples.
5. Confirm the npm `files` allow-list contains `README.zh-CN.md`, so the English
   README's language link also works in an installed package.
6. Check that generated archives, account files, caches, logs, and local paths
   are not tracked:

   ```powershell
   git status --short
   git ls-files
   ```

7. Run the same gates as release automation:

   ```powershell
   npm.cmd run check
   npm.cmd test
   npm.cmd pack --dry-run
   ```

8. Build and inspect the exact archive locally:

   ```powershell
   $pack = npm.cmd pack --json | ConvertFrom-Json
   $archive = $pack[0].filename
   tar.exe -tf $archive
   (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
   ```

   Verify that no credentials, caches, logs, tests, development archives, or
   unrelated files are included. Delete this local archive after inspection;
   the tagged workflow rebuilds its own artifact.

9. Commit the version, changelog, and any final documentation changes. Open a
   pull request and require the Node.js 22 and 24 Windows CI jobs to pass.

## Tag and publish

After the release commit is merged on the default branch:

```powershell
git switch <default-branch>
git pull --ff-only
git tag -a v0.2.0 -m "QuotaPeek 0.2.0"
git push origin v0.2.0
```

The tag workflow:

1. verifies that `v0.2.0` exactly matches `package.json` version `0.2.0`;
2. runs syntax checks and the complete test suite on Node.js 24;
3. creates the npm `.tgz` and a `.sha256` checksum;
4. publishes to npm through OIDC only when `PUBLISH_NPM=true`;
5. creates a GitHub Release with generated notes and both assets.

A tag/version mismatch fails before packaging. Do not move or reuse a public
tag. If a release contains a defect, publish a new patch.

## Verify after publication

- [ ] Download the `.tgz` and `.sha256` from GitHub Release and verify the hash.
- [ ] Compare the npm package contents and version with the release archive.
- [ ] On a clean Windows 11 x64 user profile with Node.js 22+, run:

  ```powershell
  npx.cmd --yes quotapeek@0.2.0 install
  npx.cmd --yes quotapeek@0.2.0 doctor
  ```

- [ ] Fully exit the Store app, launch **Codex + Quota**, and confirm English and
      Chinese renderer locales, quota refresh, account-menu clearance, and
      conversation scrolling.
- [ ] Run `doctor --live`, inspect its output for accidental identifiers, and
      confirm that it reports a verified loopback endpoint and quota buckets.
- [ ] Test update from the previous release and uninstall. Confirm a subsequent
      official cold launch has no CDP endpoint.
- [ ] Mark the release entry in `CHANGELOG.md` as published if that was not done
      in the release pull request.

## npm publication disabled

With `PUBLISH_NPM` absent or not exactly `true`, the npm job is skipped and the
GitHub Release still publishes. Users can install its verified `.tgz` using the
command in either README. Enable npm only after the Trusted Publisher mapping
and final package ownership have been verified.
