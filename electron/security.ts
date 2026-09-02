const CREDENTIAL_BYTES = 32;
const UINT128_MAX = (1n << 128n) - 1n;
const REVIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CredentialSession {
  #credential: Buffer | null;
  #expiryTimer: NodeJS.Timeout | null;
  readonly publicKey: string;
  readonly expiresAt: number;

  constructor(credential: Buffer, publicKey: string, ttlMs = 120_000) {
    this.#credential = Buffer.from(credential);
    this.publicKey = publicKey;
    this.expiresAt = Date.now() + ttlMs;
    this.#expiryTimer = setTimeout(() => this.destroy(), ttlMs);
    this.#expiryTimer.unref();
  }

  matches(publicKey: string): boolean {
    return this.#credential !== null && Date.now() < this.expiresAt && this.publicKey === publicKey;
  }

  consume(publicKey: string): Buffer {
    if (!this.matches(publicKey) || !this.#credential) {
      this.destroy();
      throw new Error("Unlock the IPI Card in Security before signing");
    }
    const credential = this.#credential;
    this.#credential = null;
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
    return credential;
  }

  destroy(): void {
    this.#credential?.fill(0);
    this.#credential = null;
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
  }
}

export function validateCredential(raw: unknown): Buffer {
  if (typeof raw !== "string" || !new RegExp(`^[0-9a-f]{${CREDENTIAL_BYTES * 2}}$`, "i").test(raw)) {
    throw new Error("Card credential must contain exactly 32 hexadecimal bytes");
  }
  return Buffer.from(raw, "hex");
}

export function withCredentialHex<T>(credential: Buffer, operation: (hex: string) => Promise<T>): Promise<T> {
  return operation(credential.toString("hex"));
}

export function assertUnsignedDecimal(value: unknown, label: string): string {
  const normalized = String(value);
  if (!/^[0-9]{1,78}$/.test(normalized)) throw new Error(`Malformed ${label}`);
  return normalized;
}

export function displayAmountToUint128(raw: unknown, decimals = 18): string {
  if (typeof raw !== "string" || raw.length > 80 || !/^\d+(?:\.\d+)?$/.test(raw.trim())) {
    throw new Error("Amount must be a positive decimal number");
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 38) throw new Error("Amount precision is unsupported");
  const [whole, fraction = ""] = raw.trim().split(".");
  if (fraction.length > decimals) throw new Error(`Amount supports at most ${decimals} decimals`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  if (amount > UINT128_MAX) throw new Error("Amount exceeds the supported range");
  return amount.toString();
}

export function validateReviewId(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !REVIEW_ID_PATTERN.test(raw)) throw new Error(`A valid ${label} review is required`);
  return raw;
}
