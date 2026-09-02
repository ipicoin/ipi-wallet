import { NETWORK_ORIGINS } from "./config.js";

const MAX_RESPONSE_BYTES = 1_048_576;

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const requested = new URL(url);
  if (requested.protocol !== "https:" || !NETWORK_ORIGINS.has(requested.origin)) {
    throw new Error("Network request target is not approved");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetch(requested, { ...init, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Network response exceeded the safety limit");
    if (!response.body) throw new Error("Network response had no body");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Network response exceeded the safety limit");
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Network endpoint returned malformed JSON");
    }
  } finally {
    clearTimeout(timeout);
  }
}
