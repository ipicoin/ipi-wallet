# Release procedure

1. Run `npm ci`, `npm run validate:repo`, `npm run check`, `npm test`, `npm audit --audit-level=high` and `npm run package:linux` on a clean Linux builder.
2. Save `npm run sbom` output next to `out/release-manifest.json`.
3. Verify Electron fuses and inspect the `.deb` contents before installation testing.
4. Sign the manifest and package with organization-controlled offline or CI keys.
5. Publish the package, manifest, SBOM, signature and release notes together.

Signing keys and certificate identities are intentionally not stored here. The
release job must fail closed when the organization has not configured them.
