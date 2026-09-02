# Linux browsers and OpenSC

## Why the problem returns

Some Linux OpenSC packages install
`/etc/xdg/autostart/pkcs11-register.desktop`. It runs `pkcs11-register` during
desktop login and adds OpenSC to Firefox, Thunderbird and the shared Chromium
NSS database. Browser TLS then polls every inserted smart card even when the
website does not use it. Removing `opensc` blocks from `pkcs11.txt` only lasts
until the next login.

The IPI browser guard installs the standard per-user XDG override
`~/.config/autostart/pkcs11-register.desktop` with `Hidden=true`, then removes
the already-registered browser modules. It does not disable `pcscd`, OpenSC
system libraries, `pkcs11-tool`, `opensc-tool` or the direct PC/SC bridge used
by IPI Wallet and IPI Pokédex.

## Commands

Close Firefox, Chromium/Chrome, Brave, Vivaldi, Opera and Thunderbird first.
The guard refuses to edit a live NSS database unless `--force` is explicitly
provided.

```sh
npm run browser:status
npm run browser:fix
npm run browser:restore
```

Installed Debian packages also provide `ipi-wallet-browser-guard` or
`ipi-pokedex-browser-guard` with the actions `status`, `apply` and `restore`.

Every changed NSS file receives a timestamped adjacent backup. `restore`
re-appends only the saved OpenSC block, preserves unrelated current NSS modules
and removes only an XDG override marked as IPI-managed. A pre-existing custom
override is left unchanged unless `--force` is used, in which case it is backed
up first.

## Trade-off

With the guard active, browsers cannot use OpenSC cards for TLS client
certificates, national eID login or browser-based signatures. Run
`npm run browser:restore` and log out/in when that browser integration is
needed; apply the guard again before using an IPI Card.

This mitigation addresses browser polling and PC/SC contention. It does not
repair a missing Java Card applet: a direct APDU status such as `6A82` still
means that the selected AID is not available on the card.

The per-user `Hidden=true` override follows the freedesktop.org Desktop
Application Autostart specification. OpenSC itself has documented that its
login registration can recreate browser NSS entries.
