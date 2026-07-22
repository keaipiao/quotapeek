# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-07-22

### Fixed

- Warning quota values now use a project-controlled amber color instead of a
  host theme token that some Codex themes render as red.
- Remaining quota is green above 50%, amber from 20% through 50%, and red only
  below 20%, including explicit tests for both boundary values.

## [0.4.1] - 2026-07-22

### Fixed

- Transient quota-read failures now retry after 5, 15, and 30 seconds, then
  every 30 seconds until recovery, instead of waiting for the next 60–120
  second normal poll. A successful read cancels the retry and resets backoff.
- Initial app-server provider failures use the same bounded fast recovery
  schedule, so temporary runtime or connection races recover sooner.
- Retry callbacks are invalidated on recovery and shutdown, and a read
  interrupted by shutdown can no longer publish an unavailable state or
  schedule more work.

### Changed

- During recoverable read failures, a live snapshot remains available for up
  to 15 minutes; after three minutes without a successful update it is marked
  as potentially outdated. A closed provider or Codex session can still move
  directly to unavailable.
- The READMEs now document freshness behavior, link the security architecture
  diagram, and recognize the LINUX DO open-source community.

## [0.4.0] - 2026-07-21

### Changed

- The public executable is now `codex-quota`, matching the repository and npm
  package name. The temporary `codex-q` abbreviation has been removed.
- Installation and recovery messages now use commands that work directly
  through the scoped npm package, and the default installation message simply
  tells users to open **Codex + Quota**.
- Documentation now distinguishes normal `npx` use from commands run inside a
  source checkout and makes the every-cold-start requirement explicit.

### Fixed

- The tag release workflow now accepts stable versions only, verifies that a
  tag belongs to the default branch, validates the exact public package
  contract, publishes npm idempotently, and never overwrites mismatched GitHub
  Release assets.
- Regression tests now reject the retired executable name and verify the packed
  command surface.

## [0.3.1] - 2026-07-21

### Fixed

- The npm package now publishes from the maintainer-owned scope as
  `@elonmark/codex-quota`, because npm's similarity protection rejected the
  unscoped `codex-q` name in favor of the existing `codexq` package. The
  installed executable remains `codex-q`.

## [0.3.0] - 2026-07-21

### Changed

- The repository and public project are now named **Codex Quota** under
  `keaipiao/codex-quota`; the release archive package name and CLI were changed
  to `codex-q`.
- The required cold-start shortcut is again named **Codex + Quota**, while
  owned **QuotaPeek for Codex** shortcuts are migrated safely and unrelated
  same-name shortcuts remain untouched.
- The shortcut now uses the Reserve Plane icon as a restrained launcher marker,
  and the README no longer presents a separate product logo.

## [0.2.1] - 2026-07-21

### Added

- An original QuotaPeek shortcut icon built around a quota-gauge `Q` and a
  small peek indicator, with embedded Windows sizes from 16 to 256 pixels.

### Changed

- New desktop and Start menu shortcuts are named **QuotaPeek for Codex**.
- Reinstalling safely migrates owned **Codex + Quota** shortcuts to the new
  name, while preserving same-name shortcuts that belong to the user or a
  different installation.
- Installation guidance now makes clear that `install` does not launch Codex
  and that the shortcut is used directly after installation.

## [0.2.0] - 2026-07-21

### Added

- The general quota header now shows a recognized reported plan, using current
  compatibility labels such as Free, Plus, Pro 5×, and Pro 20×, while keeping
  freshness visible.
- Automatic English, Simplified Chinese, and Traditional Chinese panel
  localization. The active Codex React-Intl locale is preferred, unsupported
  locales fall back to English, and date/time formatting is locale-aware.
- A bounded restart cache that can show the last general quota immediately as
  refreshing while a live read completes.
- `CODEX_QUOTA_DISABLE_CACHE=1` for disabling persistence and deleting an
  existing quota cache on startup.
- Public-release documentation, contribution and security policies, issue/PR
  templates, Windows Node.js 22/24 CI, and an automated tag release workflow.
- SHA-256 checksum assets for GitHub Release archives.

### Changed

- The public project, npm package, and CLI are now named QuotaPeek
  (`quotapeek`). Stable local runtime and shortcut identifiers remain
  compatible with preview installations.
- Renderer discovery and mount retries no longer impose long fixed waits during
  startup.
- Provider startup is asynchronous so panel readiness is not blocked by the
  first live quota request.
- The compact sidebar layout shows only the general quota and safely suppresses
  the matching native duplicate while data is usable.

### Security

- Automatically discovered Codex runtimes must have a valid OpenAI
  Authenticode signature; a bare `codex.exe` found on `PATH` is rejected, and
  trust helpers invoke the inbox system PowerShell by absolute path.
- Structured diagnostic logs use strengthened token/account/path redaction and
  a 1 MB per-file cap; startup cleanup removes old managed logs and trims the
  log directory to 5 MB.
- Cached data is limited to general-quota display fields, expires within 15
  minutes, is bound to an `auth.json` stat-derived context, and is deleted when
  expired or mismatched. Tokens and email addresses are never cached.
- Shortcut ownership is bound to the installation's actual managed engine
  directory, preventing an alternate `LOCALAPPDATA` profile from removing a
  different installation's shortcuts.
- Documentation now calls out residual same-user CDP access and safe diagnostic
  sharing.

## [0.1.9] - 2026-07-21

Internal preview used to validate the Windows Store app integration, quota
normalization, in-flow sidebar geometry, duplicate hiding, and local installer.
