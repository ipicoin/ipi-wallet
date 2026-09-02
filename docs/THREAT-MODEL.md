# Threat model

## Protected assets

- private keys and password-derived card credentials;
- the exact Cosmos `SignDoc` approved by the user;
- card AID/profile selection and chain identity;
- IPI Card Vault membership, invitation provenance and immutable code identity;
- release artifacts and update provenance.

## Trust boundaries and controls

The renderer is untrusted. It has no Node access, uses a fixed preload API and
all IPC calls require the top-level trusted origin. The main process validates
types, endpoints, response sizes, chain identity and transaction fields. A
review produces an opaque, expiring identifier bound to an immutable `SignDoc`.

For shared accounts, the locally remembered contract address is untrusted. The
main process accepts only the configured Card Vault code ID with no migration
administrator, then rechecks active membership or invitation immediately before
signing. Invitation acceptance proves control of the invited card address.

The vault deliberately uses one-of-N authority. Adding cards increases the
number of independent authorization paths: any active card with valid password
access can transfer all vault funds and invite or remove cards. Losing a locked
card alone does not authorize an attacker, but the card should be removed from
membership when practical. Each controller also needs native IPI for gas.

The signing credential is held in a zeroable main-process buffer for at most two
minutes and one signing attempt. It is cleared on use, lock, window blur, screen
lock, suspend, confirmed card removal and application quit. Receive-only
Ethereum/Bitcoin profiles retain no unlock authorization.

The card remains the key boundary, but it has no trusted display. A fully
compromised host can misrepresent intent before signing; independent review,
transaction policy and a future trusted confirmation device are required for
material-value use.
