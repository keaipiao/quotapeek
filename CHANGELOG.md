# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added

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
