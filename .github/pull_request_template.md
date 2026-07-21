## Summary

<!-- What problem does this solve, and what behavior changes? -->

## Verification

- [ ] `npm.cmd run check`
- [ ] `npm.cmd test`
- [ ] `npm.cmd pack --dry-run`
- [ ] Manually tested on Windows 11 x64 with the Microsoft Store app, if applicable
- [ ] Added or updated focused tests

## Security, privacy, and compatibility

- [ ] Loopback-only CDP, process/Browser identity checks, and guarded renderer probing remain intact
- [ ] No token, email, conversation, DOM dump, or real account data enters renderer payloads, caches, logs, fixtures, or screenshots
- [ ] Cache behavior remains bounded, authentication-context-scoped, and fail-closed
- [ ] Private DOM/app-server assumptions and failure behavior were reviewed
- [ ] No telemetry, remote code/selectors, or automatic app termination was added

## User-facing changes

- [ ] English and Chinese renderer strings remain in sync, or no renderer text changed
- [ ] `README.md`, `README.zh-CN.md`, and `CHANGELOG.md` were updated where needed
- [ ] Screenshots contain no identifying account or conversation content, or no screenshots are needed

## Notes for reviewers

<!-- Call out risky code paths, manual test gaps, or follow-up work. -->
