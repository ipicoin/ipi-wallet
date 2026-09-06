# Security status

This repository is an unaudited laboratory prototype. Do not use it to protect
material value.

- IPI runs on `ipi-testnet-1`.
- Ethereum and Bitcoin mainnet support is receive-only in the UI.
- The card has no trusted display or confirmation button; a compromised host
  can replace an opaque digest.
- Protocol v3 has a second user-held Recovery Password that can replace the
  Card Password while preserving card-only keys and addresses. It is not a
  private-key backup and gives its holder effective account access.
- Card Password and Recovery Password have separate 10-attempt counters per
  isolated applet. Exhausting both leaves no supported recovery path.
- Production cards require controlled issuance, unique GlobalPlatform keys,
  attestation and an independently reviewed applet.
- Vault Payment Relay is transparent receiver-balance privacy, not anonymity.
  The vault, controller, five hops, amount and recipient remain public on-chain.

Never report passwords, derived credentials, administrative card keys or
private operational logs in a public issue. Use GitHub's private
**Security → Report a vulnerability** form after the repository owner enables
private vulnerability reporting. Publishing is blocked until that channel and
an accountable security contact are configured.
