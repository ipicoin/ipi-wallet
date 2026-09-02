import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { scryptAsync } from "@noble/hashes/scrypt.js";

const encoder = new TextEncoder();
const password = encoder.encode("Correct Horse Battery Staple".normalize("NFKC"));
const cardSalt = Uint8Array.from({ length: 16 }, (_, index) => index);
const options = { N: 65_536, r: 8, p: 1, dkLen: 32, maxmem: 128 * 1024 * 1024 };

const vectors = [
  ["IPI_CARD_PASSWORD_V2\0", "07b22430f48451c44a52469857e69e2445a4212a48cf1cb50562714bebbe4afa"],
  ["IPI_CARD_ETH_MAINNET_PASSWORD_V1\0", "a2f36d1227b2a4f5c00853d6e2de6ad128b73f6bfef6841e76129be00fde9b81"],
  ["IPI_CARD_BTC_MAINNET_PASSWORD_V1\0", "f79d5f46662ae43981fd571c79ac7f7efee240575cd031cb505105667ff68291"],
  ["IPI_CARD_RECOVERY_PASSWORD_V1\0", "a9b77ca792499287a4dff96c4de5ed95ab1faef55a2335ff49f16fd3e26b9c43"],
  ["IPI_CARD_ETH_MAINNET_RECOVERY_PASSWORD_V1\0", "11a2e7c84d813eb85b1017fbe60e976d8e1864e0c340d18fe2f6b32d22497cbb"],
  ["IPI_CARD_BTC_MAINNET_RECOVERY_PASSWORD_V1\0", "dc66106a2aea665cde3cb878526dcca78683e6efdcdd0c9c090e4e0ebe5d0e94"],
];

const outputs = [];
for (const [domainText, expected] of vectors) {
  const domain = encoder.encode(domainText);
  const salt = new Uint8Array(domain.length + cardSalt.length);
  salt.set(domain);
  salt.set(cardSalt, domain.length);
  const rendererCredential = await scryptAsync(password, salt, options);
  const nodeCredential = scryptSync(password, salt, 32, options);
  assert.deepEqual([...rendererCredential], [...nodeCredential], `${domainText} must match Node scrypt`);
  assert.equal(Buffer.from(rendererCredential).toString("hex"), expected, `${domainText} must remain stable`);
  outputs.push(expected);
  rendererCredential.fill(0);
  nodeCredential.fill(0);
}
assert.equal(new Set(outputs).size, vectors.length, "each card profile must derive a different credential");
password.fill(0);
