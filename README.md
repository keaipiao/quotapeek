# QuotaPeek for Codex

[简体中文](README.zh-CN.md)

QuotaPeek adds a compact, read-only quota panel to the bottom of the Windows
Codex/ChatGPT desktop sidebar. It stays above the account footer, does not cover
conversations or account-menu items, and has no tray icon or separate window.

This is an unofficial community project and is not made or supported by OpenAI.
QuotaPeek supports routine Codex desktop updates and normally does not need to
be reinstalled after Codex updates: every cold start rediscovers the current
Store package and renderer. If diagnostics request a compatibility update,
install the latest QuotaPeek release.

## What it shows

- The general Codex allowance only, without model-specific duplicates.
- A recognized plan label such as Free, Plus, Pro 5×, or Pro 20×.
- Remaining percentage, limit period, reset time, and countdown.
- Green, amber, and red progress states as the allowance decreases.
- A recent cached value marked **Refreshing** while live data loads.

QuotaPeek follows the Codex interface language automatically. English,
Simplified Chinese, and Traditional Chinese are included; other languages fall
back to English. When QuotaPeek has usable data, it hides the equivalent native
footer quota.

## Requirements

- Windows 11 x64
- Microsoft Store version of Codex/ChatGPT (`OpenAI.Codex`)
- [Node.js 22 or newer](https://nodejs.org/)
- A ChatGPT account signed in to Codex

## Quick install

1. Install [Node.js 22 or newer](https://nodejs.org/) if it is not already
   installed.

2. Fully exit every Codex or ChatGPT desktop process.

3. Open **PowerShell** from the Start menu. Stay in the directory it opens, or
   use any other directory—there is nothing to clone and no `cd` command is
   needed.

4. Run:

   ```powershell
   npx.cmd --yes quotapeek@latest install
   ```

5. After the success message, double-click **Codex + Quota** on the Desktop or
   in the Start menu.

> The `install` command installs QuotaPeek and creates both shortcuts; it does
> **not** start Codex. After it finishes, launch the shortcut directly. You do
> not need to run an additional `npx ... start` command.

QuotaPeek is stored automatically under `%LOCALAPPDATA%\CodexQuota`; do not
change to that directory. On every future cold start, use **Codex + Quota**.
Once that process is running, the official Codex icon may be used to focus it.

### Optional terminal start

This is an alternative to double-clicking the shortcut, not an extra install
step. It works from any PowerShell directory:

```powershell
npx.cmd --yes quotapeek@latest start
```

The examples use `npx.cmd` so PowerShell does not invoke the `npx.ps1` shim;
there is no need to change the system execution policy.

## Update

Routine Codex desktop updates normally require no action and no QuotaPeek
reinstall. To update QuotaPeek itself, run the install command again from any
PowerShell directory, fully exit Codex, then reopen **Codex + Quota**:

```powershell
npx.cmd --yes quotapeek@latest install
```

## Troubleshooting

If the panel does not appear:

1. Fully exit Codex/ChatGPT; check Task Manager if necessary.
2. Reopen it through **Codex + Quota**, not the official shortcut.
3. Run this diagnostic from any PowerShell directory:

   ```powershell
   npx.cmd --yes quotapeek@latest doctor --live
   ```

If the hidden shortcut appears to do nothing, inspect:

```text
%LOCALAPPDATA%\CodexQuota\logs\launcher-error.log
```

Review diagnostic output before sharing it. Never post `auth.json`, the
contents of `%LOCALAPPDATA%\CodexQuota`, or raw logs publicly.

## Uninstall

Run from any PowerShell directory, then fully exit Codex and reopen it through
the official shortcut:

```powershell
npx.cmd --yes quotapeek@latest uninstall
```

## Security and privacy

QuotaPeek does not modify the Store package, `app.asar`, Codex configuration,
or account credentials. It uses a random loopback CDP port and the official
local app-server. CDP is not authenticated between processes running as the
same Windows user, so only run software you trust under that account. Its
short-lived local cache excludes credentials, email addresses, conversations,
DOM content, and plan information.

See [SECURITY.md](SECURITY.md) for the complete boundary and safe reporting
instructions.

## Development

```powershell
npm.cmd run check
npm.cmd test
npm.cmd pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/RELEASING.md](docs/RELEASING.md).

## License

[MIT](LICENSE)
