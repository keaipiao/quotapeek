# Codex Sidebar Quota

[简体中文](README.zh-CN.md)

Codex Sidebar Quota adds a compact, read-only quota panel to the bottom of the
Codex/ChatGPT desktop sidebar on Windows. It lives in the sidebar's normal
layout, above the account footer, so it does not cover conversations or account
menu items. There is no tray icon and no separate quota window.

> [!IMPORTANT]
> This is an unofficial, experimental community project. It is not made,
> endorsed, or supported by OpenAI. It relies on private desktop-app DOM
> structure and the bundled `codex app-server`; an app update can break it.

The Store package, `app.asar`, Codex configuration, and account credentials are
not modified. The companion cold-starts the official app with a random
loopback Chrome DevTools Protocol (CDP) port, verifies the process and renderer,
reads normalized rate limits from the official local app-server, and inserts a
small Shadow DOM component.

## What you get

- The general Codex allowance only; model-specific duplicate limits are omitted.
- Remaining percentage, actual limit period, reset time, and countdown.
- Green, amber, and red states as the remaining allowance decreases.
- A cached value shown immediately as **Refreshing** during a supported restart,
  then replaced by live data.
- Automatic panel language: English, Simplified Chinese, or Traditional
  Chinese. The active Codex React-Intl locale takes priority; DOM/browser locale
  hints are fallbacks, and unsupported languages fall back to English. Dates,
  times, numbers, and percentages still use Codex's active locale. No remote
  translation service is used.
- Safe removal of a matching native footer quota while this panel has usable
  data, avoiding two quota displays.

## Support matrix

| Component | Supported | Notes |
| --- | --- | --- |
| Operating system | Windows 11 x64 | Windows 10, Windows on Arm, macOS, and Linux are not currently supported. |
| Desktop app | Microsoft Store `OpenAI.Codex` package | The visible product name may be Codex or ChatGPT. Other distributions are not verified. |
| Node.js | 22 or 24 | Node.js 22 or newer is required; CI tests Node 22 and 24. |
| Account | Signed-in ChatGPT-backed Codex account | API-key-only or signed-out sessions do not expose the required allowance. |
| Project release | Latest `0.2.x` | Private desktop internals make compatibility best-effort. |

## Quick start

Install [Node.js 22 or newer](https://nodejs.org/), then fully exit every Codex
or ChatGPT desktop process. In PowerShell, run:

```powershell
npx.cmd --yes codex-sidebar-quota@latest install
```

Launch the new **Codex + Quota** shortcut from the Start menu or Desktop. The
installer stores an immutable runtime snapshot under
`%LOCALAPPDATA%\CodexQuota` and creates current-user shortcuts. It does not
install a global npm command.

PowerShell may block the `npx.ps1` shim under a restrictive execution policy.
Using `npx.cmd` avoids changing the execution policy.

### Install an exact version

Pin the package when reproducibility matters:

```powershell
npx.cmd --yes codex-sidebar-quota@0.2.0 install
```

### Install a GitHub Release archive

Download both `codex-sidebar-quota-0.2.0.tgz` and its adjacent `.sha256` file
from the release assets. Verify the archive before running it:

```powershell
$archive = ".\codex-sidebar-quota-0.2.0.tgz"
$expected = ((Get-Content "$archive.sha256" -Raw) -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 mismatch" }

npx.cmd --yes --package $archive codex-sidebar-quota install
```

## Why the first launch must be cold

CDP is an Electron process-start switch; it cannot be enabled after the desktop
process is already running. The first launch after a full exit must therefore
go through **Codex + Quota** or:

```powershell
npx.cmd --yes codex-sidebar-quota@0.2.0 start
```

The launcher never kills or restarts an existing Codex process. If the app is
already running without the expected CDP endpoint, fully exit it and retry.
After a successful cold start, clicking the official icon only focuses the same
running process, so the panel remains available.

Enabling CDP alone is not enough: the local companion must also verify the
browser identity, monitor renderer recreation, read quota data, inject the
panel, and send heartbeats.

## Diagnostics

Run a local read-only health check:

```powershell
npx.cmd --yes codex-sidebar-quota@0.2.0 doctor
npx.cmd --yes codex-sidebar-quota@0.2.0 doctor --live
```

`--live` also starts the official local app-server and checks that a ChatGPT
account can return rate-limit buckets. Add `--json` for machine-readable output.

The doctor intentionally omits quota values, email addresses, authentication
tokens, conversations, and DOM contents, and redacts known `USERPROFILE` and
`LOCALAPPDATA` path prefixes. Before posting its output publicly, still inspect
it and remove anything you consider identifying, such as a remaining local
path, process ID, or environment detail. Never upload `auth.json`,
`%LOCALAPPDATA%\CodexQuota`, session files, or raw logs.

If a hidden shortcut appears to do nothing, inspect
`%LOCALAPPDATA%\CodexQuota\logs\launcher-error.log` locally and rerun
`doctor --live` from a visible terminal.

## Update

Install the new version over the current one, fully exit the desktop app, and
start it again through **Codex + Quota**:

```powershell
npx.cmd --yes codex-sidebar-quota@latest install
```

The current process continues using its already verified snapshot until it
exits; the next cold start uses the newly installed version.

## Uninstall

```powershell
npx.cmd --yes codex-sidebar-quota@latest uninstall
```

This stops the verified companion, removes its owned shortcuts, and removes
`%LOCALAPPDATA%\CodexQuota`. The desktop process may still have CDP enabled
until it fully exits. Reopen it through the official shortcut to return to a
normal non-CDP launch.

## Cache and privacy

The restart cache lasts at most 15 minutes and contains only allow-listed fields
needed to display the general quota: normalized bucket/window identifiers,
remaining or used percentages, duration, reset timestamp, and fetch timestamp.
It never stores an authentication token, email address, conversation, DOM
content, reset-credit value, display label, or model-specific quota.

Cache reuse is bound to a local authentication context derived only from
`auth.json` file metadata (`stat`), not its contents. No cache is written or
read without that context. An expired, malformed, or context-mismatched cache
is deleted instead of displayed. See [SECURITY.md](SECURITY.md) for the full
security boundary.

Set `CODEX_QUOTA_DISABLE_CACHE=1` in the launching process environment, or as a
Windows user environment variable, to disable persistence. On the next cold
start, the companion skips cache reads and writes and deletes any existing
quota cache. A user-level setting applies only to newly started processes, so
fully exit the desktop app before testing it.

## CDP security warning

CDP on `127.0.0.1` is not authenticated between processes running as the same
Windows user. Another process under that user may discover the random port and
attach to the desktop renderer while the app is running. Store-package checks,
listener-owner validation, a pinned Browser identity, and guarded `app://`
renderer probes reduce accidental or confused attachment; they do not remove
this same-user risk.

Fully exit the CDP-started desktop app and reopen it through the official icon
to close the endpoint. Stopping only the quota companion does not remove a
switch already applied to the desktop process.

## Development

```powershell
npm.cmd run check
npm.cmd test
npm.cmd pack --dry-run
```

The automated suite uses fixtures and does not read a real account. Live account
checks are opt-in through `doctor --live`.

Contributions are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md). Release
maintainers should follow [docs/RELEASING.md](docs/RELEASING.md). Security
reports belong in GitHub Private Vulnerability Reporting, as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
