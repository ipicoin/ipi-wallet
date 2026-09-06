# Changelog

## Unreleased

- Made a vault with two or more active cards the sole primary IPI account in
  Overview, Receive and Send while retaining card addresses only as technical
  signing-controller identifiers.
- Fixed address copying by routing it through Electron's native clipboard and
  showing visible success or failure feedback.
- Kept immutable vault reviews available while unlocking a card, extended their
  lifetime to five minutes and refreshed stale reviews before execution.
- Replaced the raw account-query HTTP 404 with an actionable funding message
  for newly initialized card addresses and clarified the vault creation fee.
- Enabled the independently verified `ipi-testnet-1` Card Vault deployment at
  code ID `2` by default while retaining an explicit environment override.
- Integrated one shared Card Vault address with fully equal, unnumbered one-of-N
  cards and vault-sponsored CosmWasm execution fees.
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
