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

## Wallet identity session

The main process starts without an account and creates a process-local identity
session only after reading an initialized IPI applet. That session contains
public keys, derived addresses and the last card profile metadata for IPI,
Ethereum and Bitcoin. It is never persisted and contains neither private keys
nor password-derived credentials.

Removing the card changes the session to view-only instead of removing the
account from the renderer. Public balances and receive addresses can continue
to refresh. A signing request fails closed unless PC/SC can read the same IPI
public key and credential salt that produced the reviewed transaction. Inserting
a different initialized IPI Card replaces the session and invalidates pending
reviews and one-use unlock authorization. Application exit discards everything.

Card firmware, CAP builds, card inspection and issuance belong to the separate
private `ipi-pokedex` repository. The protocol boundary between the repositories
is the versioned APDU contract implemented by the bridge and applets.

## IPI Card Vault

The separate `ipi-wallet-multicards` repository contains the immutable CosmWasm
one-of-N account and its server deployment material. The contract address is
the shared receive address. Every accepted card keeps its own key and controller
address; any active controller can transfer vault funds, invite another
controller, cancel invitations or remove members. There are no card numbers,
labels or privileged roles. An invitation belongs to the vault and becomes
membership only when the invited card signs `accept_invitation` itself.

The renderer may remember a vault address, but that value is untrusted. Before
querying or signing, the main process validates the address, exact configured
code ID, absent migration administrator, contract response schema, current
membership, fee grant and human-readable action. Contract execution uses the
same opaque, expiring `SignDoc` review and local signature verification as
native transfers. The vault sponsors execution fees when its restricted
feegrant and balance are available; otherwise the controller address pays.
When at least two cards are active, the renderer treats the contract as the
only primary IPI wallet: Overview and Receive expose its address and Send uses
it without offering a controller-account source. Controller addresses remain
necessary on-chain signer identities and are shown only as shortened management
identifiers; incoming transfers to them cannot be prevented by the wallet.

## Build outputs

`dist/`, `dist-electron/` and Python bytecode are generated artifacts and are
not committed. `npm run build` recreates the web bundle, Electron main/preload
code and the runtime copy of `card_bridge.py`.
