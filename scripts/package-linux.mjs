import { createPackage } from "@electron/asar";
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = resolve(projectRoot, "out");
const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
if (!arch) throw new Error(`Unsupported Linux architecture: ${process.arch}`);

const appRoot = resolve(outRoot, `ipi-wallet-linux-${arch}`);
const bundleRoot = resolve(outRoot, ".app-bundle");
const debRoot = resolve(outRoot, `.deb-root-${arch}`);
for (const target of [appRoot, bundleRoot, debRoot]) {
  if (!target.startsWith(`${outRoot}/`)) throw new Error("Refusing to clean a path outside the package output directory");
  rmSync(target, { recursive: true, force: true });
}
mkdirSync(outRoot, { recursive: true });

const electronDist = join(projectRoot, "node_modules/electron/dist");
if (!existsSync(join(electronDist, "electron"))) throw new Error("Electron Linux distribution is not installed");
cpSync(electronDist, appRoot, { recursive: true, preserveTimestamps: true });
renameSync(join(appRoot, "electron"), join(appRoot, "ipi-wallet"));

mkdirSync(bundleRoot, { recursive: true });
cpSync(join(projectRoot, "dist"), join(bundleRoot, "dist"), { recursive: true });
cpSync(join(projectRoot, "dist-electron"), join(bundleRoot, "dist-electron"), { recursive: true });
rmSync(join(bundleRoot, "dist-electron/card_bridge.py"), { force: true });
const packageLock = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8"));
for (const [relative, metadata] of Object.entries(packageLock.packages)) {
  if (!relative.startsWith("node_modules/") || metadata.dev) continue;
  if (relative.includes("..")) throw new Error("Lockfile contains an unsafe dependency path");
  const source = join(projectRoot, relative);
  if (!existsSync(source)) throw new Error(`Production dependency is not installed: ${relative}`);
  const target = join(bundleRoot, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
const projectPackage = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(projectPackage.version)) throw new Error("package.json contains an invalid release version");
cpSync(join(projectRoot, "LICENSE"), join(bundleRoot, "LICENSE"));
cpSync(join(projectRoot, "NOTICE"), join(bundleRoot, "NOTICE"));
writeFileSync(join(bundleRoot, "package.json"), `${JSON.stringify({
  name: projectPackage.name,
  version: projectPackage.version,
  license: projectPackage.license,
  main: "dist-electron/main.js",
  type: "module",
  dependencies: projectPackage.dependencies,
}, null, 2)}\n`, { mode: 0o644 });

mkdirSync(join(appRoot, "resources"), { recursive: true });
await createPackage(bundleRoot, join(appRoot, "resources/app.asar"));
cpSync(join(projectRoot, "electron/card_bridge.py"), join(appRoot, "resources/card_bridge.py"));
cpSync(join(projectRoot, "public/ipi-wallet.png"), join(appRoot, "resources/ipi-wallet.png"));

await flipFuses(join(appRoot, "ipi-wallet"), {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
});

const installRoot = join(debRoot, "opt/ipi-wallet");
mkdirSync(installRoot, { recursive: true });
cpSync(appRoot, installRoot, { recursive: true, preserveTimestamps: true });
mkdirSync(join(debRoot, "DEBIAN"), { recursive: true });
writeFileSync(join(debRoot, "DEBIAN/control"), [
  "Package: ipi-wallet",
  `Version: ${projectPackage.version}`,
  `Architecture: ${arch}`,
  "Maintainer: IPI",
  "Depends: python3, python3-pyscard, pcscd",
  "Section: utils",
  "Priority: optional",
  "Homepage: https://www.ipi.io",
  "Description: Card-only desktop wallet for IPI",
  "",
].join("\n"), { mode: 0o644 });
mkdirSync(join(debRoot, "usr/share/applications"), { recursive: true });
mkdirSync(join(debRoot, "usr/share/icons/hicolor/512x512/apps"), { recursive: true });
cpSync(join(projectRoot, "public/ipi-wallet.png"), join(debRoot, "usr/share/icons/hicolor/512x512/apps/ipi-wallet.png"));
writeFileSync(join(debRoot, "usr/share/applications/ipi-wallet.desktop"), [
  "[Desktop Entry]",
  "Type=Application",
  "Name=IPI Wallet",
  "Exec=/opt/ipi-wallet/ipi-wallet",
  "Icon=ipi-wallet",
  "StartupWMClass=ipi-wallet",
  "Categories=Finance;Utility;",
  "Terminal=false",
  "",
].join("\n"), { mode: 0o644 });
mkdirSync(join(debRoot, "usr/bin"), { recursive: true });
cpSync(join(projectRoot, "scripts/host/ipi-browser-guard.sh"), join(debRoot, "usr/bin/ipi-wallet-browser-guard"));
mkdirSync(join(debRoot, "usr/share/doc/ipi-wallet"), { recursive: true });
cpSync(join(projectRoot, "LICENSE"), join(debRoot, "usr/share/doc/ipi-wallet/copyright"));
cpSync(join(projectRoot, "NOTICE"), join(debRoot, "usr/share/doc/ipi-wallet/NOTICE"));
cpSync(join(projectRoot, "docs/LINUX-SMARTCARD-BROWSERS.md"), join(debRoot, "usr/share/doc/ipi-wallet/LINUX-SMARTCARD-BROWSERS.md"));

function normalizePermissions(directory) {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) normalizePermissions(path);
    else chmodSync(path, 0o644);
  }
}
normalizePermissions(debRoot);
chmodSync(join(debRoot, "usr/bin/ipi-wallet-browser-guard"), 0o755);
for (const executable of ["ipi-wallet", "chrome_crashpad_handler", "libffmpeg.so", "libvk_swiftshader.so", "libvulkan.so.1"]) {
  chmodSync(join(installRoot, executable), 0o755);
}
chmodSync(join(installRoot, "chrome-sandbox"), 0o4755);

const debPath = join(outRoot, `ipi-wallet_${projectPackage.version}_${arch}.deb`);
rmSync(debPath, { force: true });
const result = spawnSync("dpkg-deb", ["--root-owner-group", "--build", debRoot, debPath], { stdio: "inherit" });
if (result.status !== 0) throw new Error("dpkg-deb failed");
console.log(debPath);
