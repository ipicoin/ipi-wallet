# IPI Wallet

Desktop wallet prototype for Linux, built with Electron, TypeScript and Vite.
Private keys are generated and retained by isolated Java Card applets; the
application only reads public keys and requests authorized signatures.

## Current scope

- IPI Testnet account, balance, receive and card-signed Send;
- an in-memory, view-only wallet session after the identified card is removed;
- optional immutable CosmWasm IPI Card Vault with one-of-N shared access,
  delegated card invitations, card revocation and card-signed contract transfers;
- Ethereum Mainnet address, balance and receive only;
- Bitcoin Mainnet native SegWit address, balance and receive only;
- isolated password/KDF domains for every card profile;
- one-pass, resumable initialization of all factory profiles with one shared
  Card Password and one shared Recovery Password; both become three
  profile-domain-separated credentials;
- local signature verification and low-S normalization before IPI broadcast;
- sandboxed renderer, isolated preload API and PC/SC bridge over stdin;
- dark/light UI and QR receive codes.

This is an unaudited laboratory build. Mainnet Send is deliberately disabled.
Read [SECURITY.md](SECURITY.md) before connecting a card.

## Requirements

- Linux with PC/SC (`pcscd`) and a compatible reader;
- Node.js 24 and npm;
- Python 3.11+ with `pyscard`;
- an IPI Card carrying compatible applets from the private `ipi-pokedex`
  repository.

After Pokédex provisions the three applets, open **IPI Card** and choose
**Initialize card**. Wallet generates one independent private key inside each
factory applet. Individual currency initialization is disabled. If the sequence
is interrupted, running it again verifies both shared passwords on completed
profiles before continuing.

At every application start the wallet has no account selected. Inserting or
tapping an initialized card opens an in-memory session containing only public
addresses and profile metadata. The card can then be removed while balances and
receive addresses remain visible. Every signing operation still requires the
same physical card to be present and unlocked; another initialized card switches
the active session. Closing the application discards the session.

## Development setup

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
npm run dev
```

`IPI_WALLET_PYTHON` can point Electron at a specific Python interpreter. RPC
overrides are available through `IPI_ETHEREUM_MAINNET_RPC` and
`IPI_BITCOIN_MAINNET_API`.

The shared-card feature requires the contract in
[`contracts/ipi-card-vault`](contracts/ipi-card-vault) to be reviewed, stored on
IPI Testnet and configured through `IPI_CARD_VAULT_CODE_ID`. The wallet accepts
only immutable instances matching that exact code ID. Every controller address
needs a small IPI balance for its own transaction fees, including invitation
acceptance.

## Validation and production-mode run

```sh
npm run validate:repo
npm run check
npm test
npm run build
npm start
```

Contract validation additionally requires Rust 1.85.0:

```sh
npm run contract:test
npm run contract:build
```

`npm run package:linux` creates a fused ASAR application and Debian package in
`out/`, together with `release-manifest.json`. Generated folders are local only
and ignored by Git. See [docs/RELEASE.md](docs/RELEASE.md) for signing and SBOM
release gates.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for repository boundaries and
runtime responsibilities. If installing OpenSC makes Firefox or Chromium stall
while an IPI Card is inserted, use the persistent, reversible browser guard
described in [docs/LINUX-SMARTCARD-BROWSERS.md](docs/LINUX-SMARTCARD-BROWSERS.md).
