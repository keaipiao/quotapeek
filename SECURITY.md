# Security policy

QuotaPeek for Codex is an unofficial local companion that deliberately enables
a loopback Chrome DevTools Protocol endpoint in the official desktop process.
Please understand this boundary before installing it.

## Supported versions

Security fixes are provided only for the latest released patch in the `0.2.x`
line.

| Version | Supported |
| --- | --- |
| Latest `0.2.x` | Yes |
| Older `0.2.x` patches | No; update first |
| `0.1.x` and earlier | No |

Because the project is pre-1.0 and depends on private desktop internals,
compatibility fixes may require upgrading rather than backporting.

## Report a vulnerability privately

Do not open a public issue, discussion, or pull request for a suspected
vulnerability. In this repository, open the **Security** tab, choose
**Advisories**, then **Report a vulnerability**. This uses GitHub Private
Vulnerability Reporting and keeps the report visible only to repository
maintainers until coordinated disclosure.

Include:

- the affected QuotaPeek version;
- Windows, Node.js, and Store app versions;
- a minimal reproduction and expected impact;
- whether another same-user process is required;
- suggested remediation, if known.

Remove tokens, email addresses, account data, conversation content, local
usernames, and unrelated logs. Maintainers handle reports on a best-effort
basis; no fixed response or remediation SLA is promised.

## CDP boundary and residual risk

CDP does not authenticate processes running as the same Windows user. A
malicious same-user process may discover the random loopback port and attach to
the renderer while the CDP-started desktop process remains alive. Loopback-only
binding prevents direct remote access, but does not make the endpoint private
from the local user session.

The launcher validates the Microsoft Store package, verifies listener ownership,
pins the original Browser identity, accepts only guarded `app://` renderer
targets, and fails closed when the sidebar anchor or layout is ambiguous. These
controls prevent confused attachment by this project; they cannot impose
authentication on CDP itself.

To remove the endpoint, fully exit the CDP-started desktop app and reopen it
through the official shortcut. Stopping only the quota daemon is insufficient
because the CDP switch belongs to the desktop process.

## Application compatibility boundary

The project depends on non-public Codex/ChatGPT desktop DOM structure and the
bundled `codex app-server`. An official app update can change either interface
without notice. The injector removes itself instead of using an overlay when it
cannot uniquely identify and validate the expected sidebar geometry.

This project is not an OpenAI plugin and is not affiliated with, endorsed by,
or supported by OpenAI.

## Data handling

- Quota data comes from the official local `codex app-server` stdio transport.
- The renderer receives only a normalized, allow-listed display object.
- No authentication token, email address, conversation, DOM dump, or account
  menu contents are sent to the injected component or deliberately logged.
- There is no telemetry and no remote selector, script, translation, or theme
  download.
- Automatic Codex runtime discovery requires valid OpenAI Authenticode. A bare
  executable found on `PATH` is rejected, and trust-inspection helpers invoke
  the inbox system PowerShell by absolute path.
- Structured diagnostic logs apply token, account, and path redaction and cap
  each structured file at 1 MB. Managed logs older than seven days are removed
  and the directory is trimmed to 5 MB at companion startup. Raw daemon stream
  files are not a supported sharing format and must be treated as private.

### Restart cache

The optional restart cache has a maximum lifetime of 15 minutes. It stores only
fields needed for the general quota display: normalized bucket/window
identifiers, used or remaining percentages, duration, reset and fetch
timestamps. It does not retain model-specific quota, reset-credit values,
display labels, authentication tokens, email addresses, conversations, or DOM
content.

Cache reuse is bound to an authentication context derived only from
`auth.json` file metadata (`stat`); the cache layer does not read or copy the
file contents. Without a valid account context it neither reads nor writes a
cache. Expired, malformed, future-dated, or context-mismatched cache data is
deleted and never rendered.

`CODEX_QUOTA_DISABLE_CACHE=1`, set in either the launching process environment
or the Windows user environment, disables cache reads and writes. At startup it
also causes any existing quota cache to be deleted. A user-level environment
change affects newly started processes, so the desktop app must be fully exited
before relying on it.

## Sharing diagnostics safely

`doctor` and `doctor --live` are designed to omit quota values, emails, tokens,
conversations, and DOM contents. They also redact known `USERPROFILE` and
`LOCALAPPDATA` path prefixes. Automated message sanitization is defense in
depth, not a guarantee that every environment-specific identifier is harmless.

Before sharing output:

1. Read the entire output yourself.
2. Remove local usernames, full filesystem paths, process IDs, or machine details
   you do not want public.
3. Never attach `auth.json`, `%LOCALAPPDATA%\CodexQuota`, `session.json`,
   `install.json`, cache files, or raw launcher/daemon logs.
4. Prefer the normal human-readable doctor output over `--json` unless maintainers
   specifically request JSON.
