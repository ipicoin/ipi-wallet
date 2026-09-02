# IPI Wallet architecture

IPI Wallet is an Electron desktop application with three trust boundaries:

1. The sandboxed renderer displays balances and collects user intent.
2. The Electron main process validates requests, talks to network endpoints,
   builds transactions and verifies card signatures.
3. `electron/card_bridge.py` is the narrow PC/SC adapter for IPI Java Card
   applets. Arguments are delivered over stdin, not process arguments.

The application never generates or exports a private key. Each supported
network uses an isolated card applet and key pair. The IPI Testnet adapter can
build and broadcast `SIGN_MODE_DIRECT` transfers. Ethereum Mainnet and Bitcoin
Mainnet are receive-only until transaction-intent validation is designed and
reviewed. Protocol v3 password recovery changes only the signing credential;
the private keys and addresses stay unchanged inside their applets.

Card firmware, CAP builds, card inspection and issuance belong to the separate
private `ipi-pokedex` repository. The protocol boundary between the repositories
is the versioned APDU contract implemented by the bridge and applets.

## IPI Card Vault

`contracts/ipi-card-vault` is an immutable CosmWasm one-of-N account for native
IPI. The contract address is the shared receive address. Every accepted card
keeps its own key and controller address; any active controller can transfer
vault funds or invite another controller. An invitation records its active
inviter and becomes membership only when the invited card signs
`accept_invitation` itself. Consequently, invitation authority propagates to
every accepted card without copying private keys.

The renderer may remember a vault address, but that value is untrusted. Before
querying or signing, the main process validates the address, exact configured
code ID, absent migration administrator, contract response schema, current
membership and human-readable action. Contract execution uses the same opaque,
expiring `SignDoc` review and local signature verification as native transfers.
The controller address pays gas while the transferred amount comes from the
vault balance.

## Build outputs

`dist/`, `dist-electron/` and Python bytecode are generated artifacts and are
not committed. `npm run build` recreates the web bundle, Electron main/preload
code and the runtime copy of `card_bridge.py`.
