import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(projectRoot, "out");
const artifacts = readdirSync(outRoot).filter((name) => name.endsWith(".deb") || name.endsWith(".AppImage"));
if (artifacts.length === 0) throw new Error("No release artifacts found in out/");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  electron: JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).devDependencies.electron,
  artifacts: artifacts.sort().map((name) => ({ name, bytes: statSync(join(outRoot, name)).size, sha256: sha256(join(outRoot, name)) })),
};
writeFileSync(join(outRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
