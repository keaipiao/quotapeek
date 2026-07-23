# Codex Quota

[简体中文](README.zh-CN.md)

Codex Quota adds a compact, read-only quota panel to the bottom of the Windows
Codex/ChatGPT sidebar. It shows the general allowance without covering
conversations or the account menu, and it has no tray icon or separate window.

This is an unofficial community project and is not made or supported by OpenAI.

## Install

Requirements: Windows 11 x64, the Microsoft Store Codex/ChatGPT app
(`OpenAI.Codex`), Node.js 22 or newer, and a ChatGPT account signed in to Codex.

1. Install [Node.js 22 or newer](https://nodejs.org/) if needed.
2. Fully exit every Codex/ChatGPT desktop process.
3. Open **PowerShell** in its default directory, or any directory outside a
   Codex Quota source checkout. You do not need to clone this repository or run
   `cd`.
4. Run:

   ```powershell
   npx.cmd --yes @elonmark/codex-quota@latest install
   ```

5. When installation succeeds, directly open **Codex + Quota** from the
   Desktop or Start menu.

The install command creates the shortcuts but does **not** launch Codex. There
is no extra `npx ... start` step. Codex Quota is stored under
`%LOCALAPPDATA%\CodexQuota`; you do not need to open that directory.

For every future cold start, use **Codex + Quota**. If Codex is already
running, its official icon can still bring the same process to the foreground.

## What it shows

- The general Codex allowance only, without model-specific duplicates.
- A recognized plan such as Free, Plus, Pro 5×, or Pro 20×.
- Remaining percentage, limit period, reset time, and countdown.
- Green above 50%, amber from 20% through 50%, and red below 20%.
- The most recent cached value marked **Refreshing** until live data arrives.

The panel follows the Codex interface language automatically. English,
Simplified Chinese, and Traditional Chinese are built in; other languages fall
back to English. Codex Quota identifies the native low-usage card by its exact
UI structure rather than translated text. A document-lifetime policy hides its
docked, floating-sidebar, and compact-window copies from startup onward,
independently of quota loading. The custom panel keeps the latest snapshot
pre-rendered in one document-lifetime host while the sidebar is absent. That
same host moves into docked and floating sidebars before paint, including
hidden floating surfaces before their reveal animation. Brief route and resize
layout settling keeps an already visible panel in place instead of hiding and
re-inserting it. Entering Settings parks the custom card before the Settings
frame is painted; it returns only when the main conversation sidebar is ready.

### Data freshness

**May be outdated** does not mean the allowance itself has expired. It means
the latest successful quota read is more than three minutes old. Codex Quota
normally refreshes every 60–120 seconds. After a failed read, it retries after
5, 15, and then 30 seconds, continuing at 30-second intervals while the local
app-server is unavailable. The badge returns to **Live** after the next
successful read. During ordinary read failures, only a continuous failure
beyond three minutes produces this warning, and values older than 15 minutes
are no longer shown. A closed provider or Codex session can become unavailable
immediately instead.

## Update

Routine Codex desktop updates require no Codex Quota reinstall. To update
Codex Quota itself, run this from the default PowerShell directory (or any
directory outside its source checkout), fully exit Codex, and then reopen
**Codex + Quota**:

```powershell
npx.cmd --yes @elonmark/codex-quota@latest install
```

An update safely replaces shortcuts created by this project, including the old
**QuotaPeek for Codex** name. Same-name shortcuts not owned by Codex Quota are
preserved.

## Troubleshooting

If the panel does not appear:

1. Fully exit Codex/ChatGPT; check Task Manager if needed.
2. Cold-start it through **Codex + Quota**, not the official shortcut.
3. Run from the default PowerShell directory or any directory outside a Codex
   Quota source checkout:

   ```powershell
   npx.cmd --yes @elonmark/codex-quota@latest doctor --live
   ```

If the hidden launch does nothing, inspect
`%LOCALAPPDATA%\CodexQuota\logs\launcher-error.log`. Never publish `auth.json`,
the contents of `%LOCALAPPDATA%\CodexQuota`, or unreviewed raw logs.

As a terminal-only alternative to the shortcut, run from the default
PowerShell directory or any directory outside a Codex Quota source checkout:

```powershell
npx.cmd --yes @elonmark/codex-quota@latest start
```

## Uninstall

Run from the default PowerShell directory or any directory outside a Codex
Quota source checkout, then fully exit Codex and reopen it through the official
shortcut:

```powershell
npx.cmd --yes @elonmark/codex-quota@latest uninstall
```

## Security and development

Codex Quota does not modify the Store package, `app.asar`, Codex configuration,
or account credentials. It uses a random loopback CDP port and the official
local app-server. See [SECURITY.md](SECURITY.md) for the security boundary and
the [security architecture diagram (Simplified Chinese)](https://github.com/keaipiao/codex-quota/blob/main/docs/assets/codex-quota-security-architecture-zh.png)
for a visual overview.

```powershell
npm.cmd run check
npm.cmd test
npm.cmd pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md),
[docs/RELEASING.md](docs/RELEASING.md), and the [MIT license](LICENSE).

## Community

Codex Quota recognizes and thanks the open-source community
[LINUX DO](https://linux.do/).
