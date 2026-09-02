import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";

const git = (arguments_) => {
  const result = spawnSync("git", arguments_, { encoding: null });
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8").trim() || `git ${arguments_.join(" ")} failed`);
  return result.stdout;
};

const candidates = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const forbiddenPath = /(?:^|\/)(?:node_modules|dist|dist-electron|out|target|__pycache__)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:log|pem|key|p12|pfx|pyc)$/i;
const secretPatterns = [
  /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/,
  /(?:^|\n)\s*(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE|SCP03_(?:ENC|MAC|DEK))\s*=/i,
  /\bgh[oprsu]_[A-Za-z0-9_]{30,}\b/,
];
const binaryExtensions = new Set([".ico", ".png"]);
const violations = [];

for (const path of candidates) {
  if (!existsSync(path)) continue;
  if (path === ".env.example") continue;
  if (forbiddenPath.test(path)) {
    violations.push(`${path}: generated, secret or local-only path`);
    continue;
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile()) {
    violations.push(`${path}: repository entries must be regular files`);
    continue;
  }
  if (metadata.size > 2 * 1024 * 1024 || binaryExtensions.has(extname(path).toLowerCase())) continue;
  const content = readFileSync(path, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) violations.push(`${path}: possible private credential`);
  if (path.startsWith(".github/workflows/")) {
    for (const match of content.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const action = match[1];
      if (!action.startsWith("./") && !/@[0-9a-f]{40}$/i.test(action)) {
        violations.push(`${path}: external action ${action} is not pinned to a full commit SHA`);
      }
    }
  }
  if (content.includes("\r") || /[ \t]+$/m.test(content) || (content.length > 0 && !content.endsWith("\n"))) {
    violations.push(`${path}: text files must use LF, avoid trailing whitespace and end with a newline`);
  }
}

const whitespace = spawnSync("git", ["diff", "--check"], { encoding: "utf8" });
if (whitespace.status !== 0) violations.push(whitespace.stdout.trim() || whitespace.stderr.trim());
const stagedWhitespace = spawnSync("git", ["diff", "--cached", "--check"], { encoding: "utf8" });
if (stagedWhitespace.status !== 0) violations.push(stagedWhitespace.stdout.trim() || stagedWhitespace.stderr.trim());

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (packageJson.private !== true) violations.push("package.json: wallet package must remain private");
if (packageJson.license !== "UNLICENSED") violations.push("package.json: proprietary package must remain marked UNLICENSED");
if (packageLock.lockfileVersion !== 3 || packageLock.packages?.[""]?.version !== packageJson.version) {
  violations.push("package-lock.json: root package metadata is inconsistent");
}

if (violations.length > 0) {
  throw new Error(`Repository validation failed:\n- ${violations.join("\n- ")}`);
}

console.log(`Repository validation passed (${candidates.length} candidate files)`);
