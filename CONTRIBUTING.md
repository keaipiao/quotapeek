# Contributing

Thanks for helping improve QuotaPeek for Codex. The project is intentionally
small and conservative because it crosses a CDP security boundary and relies on
private desktop-app structure.

## Before opening a change

- Use a public issue for reproducible bugs or a focused feature proposal.
- Use GitHub Private Vulnerability Reporting for security issues; do not discuss
  an undisclosed vulnerability in a public issue or pull request.
- Keep proposals within the current scope: Windows 11 x64, the Microsoft Store
  `OpenAI.Codex` package, Node.js 22+, and an in-sidebar quota display.
- Never include real account data, tokens, emails, conversations, DOM dumps, or
  raw user logs in fixtures or commits.

## Development setup

Clone the repository on Windows 11 x64 and install Node.js 22 or 24. The package
currently has no third-party runtime dependencies.

```powershell
npm.cmd run check
npm.cmd test
npm.cmd pack --dry-run
```

The unit tests use synthetic fixtures and must not connect to a real account.
`doctor --live` is opt-in and should be used only on a machine and account you
control.

For a local manual installation from the checkout:

```powershell
node .\bin\quotapeek.mjs install
```

Fully exit the desktop app before testing a new cold start. Do not automate
termination of a user's existing Codex/ChatGPT process.

## Change expectations

- Preserve loopback-only CDP, Store-package/owner checks, Browser identity
  pinning, guarded renderer probing, and fail-closed layout validation.
- Treat DOM selectors and app-server shapes as private, version-sensitive
  interfaces. Add focused fixtures for every compatibility change.
- Keep the renderer payload allow-listed. Account identifiers and credentials
  must not cross into renderer code or logs.
- Any persisted quota cache must remain bounded to 15 minutes, scoped to the
  verified authentication-stat context, and deleted on expiry or mismatch.
- User-facing renderer text must be added to the English, Simplified Chinese,
  and Traditional Chinese locale tables. Unsupported or missing locales must
  fall back to English.
- Do not add telemetry, remote code, remote selectors, or automatic application
  termination.
- Update both `README.md` and `README.zh-CN.md` when behavior or commands change,
  and add a `CHANGELOG.md` entry.

## Pull requests

Keep each pull request focused. Complete the pull request template and report:

- the problem and behavior change;
- security, privacy, and private-DOM compatibility impact;
- automated tests run under Node.js 22 and/or 24;
- manual Windows/Store-app checks, when relevant;
- before/after screenshots for visible UI changes, with identifying content
  removed.

CI runs syntax checks, the full test suite, and a package dry-run on Windows for
Node.js 22 and 24. A passing CI result does not replace manual review of CDP and
data-handling changes.

By contributing, you agree that your contribution is licensed under the
repository's MIT license.
