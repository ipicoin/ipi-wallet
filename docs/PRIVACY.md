# Network privacy

Balance and transaction queries disclose wallet addresses and timing to the
configured IPI REST/Comet/EVM, Ethereum and Bitcoin providers. Overrides must be
HTTPS URLs without embedded credentials. The application does not send private
keys or passwords to these endpoints.

Vault payments use five public, zero-retention relay contracts in randomized
order. This keeps the vault from being the immediate bank sender displayed by a
basic merchant receiver, but it does not hide the route from the chain. The
vault, active controller, amount, recipient and every hop are deliberately
recoverable from public transaction events. Anyone with explorer or REST access
can trace them; the **Deanonimizer** tab in `ipi-pokedex` automates that public
analysis.

Vault address and balance are hidden in the UI while IPI is locked. The locally
remembered association is not encrypted against someone who already controls
the desktop account or process. Logout clears process memory and closes the
application; it does not erase public chain history or the remembered vault.

For stronger privacy, operate organization-controlled endpoints and set the
documented environment overrides. Do not attach card analysis logs, addresses
or derived credentials to public issues.
