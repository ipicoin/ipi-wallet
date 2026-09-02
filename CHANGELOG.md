# Changelog

## Unreleased

- Added a process-local, view-only wallet session that survives card removal.
- Required the same physical IPI Card to be present for every signing operation.
- Added automatic session switching when another initialized card is detected.
- Confined scrolling to the active content section while keeping the application chrome fixed.
- Added resumable whole-card initialization for all three isolated card profiles.
- Updated Electron to 44.0.0 and removed vulnerable packaging dependencies.
- Added strict production-profile selection, trusted-origin IPC and bounded HTTPS responses.
- Bound execution to an expiring immutable review and locally verified transaction hash.
- Added zeroable one-use unlock sessions, tests, CodeQL, Dependabot and fused Debian packaging.
- Added reviewed cancellation of pending invitations and removal of active Card Vault members.
- Hardened renderer fallback, single-instance execution, endpoint validation and bounded transaction inputs.
- Fixed Linux package startup by disabling an unsupported browser-specific V8 snapshot fuse.
- Added repository secret/artifact validation and consistent package metadata sourced from `package.json`.
