# IPI Card Vault

This contract is covered by the repository's proprietary license.

CosmWasm contract implementing one shared IPI account controlled by an
unbounded, on-chain set of IPI Cards. Every active card has full one-of-N
authority and may invite another card. An invitation becomes active only after
the invited card submits `accept_invitation` from its own address.

## Access model

- The instantiating address is the first active card.
- Every active card can transfer native `aipi`, invite another card, cancel an
  invitation, or remove an active card.
- Invitations retain their inviter. They cannot be accepted after that inviter
  has been removed.
- The final active card cannot be removed.
- Membership uses keyed storage and paginated queries; transfers do not iterate
  through the member set.

Instantiate without an admin so that no external key can replace the contract
code. The contract accepts `aipi` at instantiation, and its address can receive
later bank transfers normally. Execute calls reject attached funds.

## Validation

```sh
cargo +1.85.0 test --locked --manifest-path contracts/ipi-card-vault/Cargo.toml
cargo +1.85.0 build --locked --release --target wasm32-unknown-unknown \
  --manifest-path contracts/ipi-card-vault/Cargo.toml
```

For production deployment, optimize the Wasm artifact, verify its SHA-256
checksum, store it on IPI, and configure the resulting code ID in IPI Wallet.
