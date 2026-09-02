import { afterEach, describe, expect, it, vi } from "vitest";
import { assertUnsignedDecimal, CredentialSession, displayAmountToUint128, validateCredential, validateReviewId } from "./security.js";

describe("credential handling", () => {
  afterEach(() => vi.useRealTimers());

  it("accepts exactly 32 hexadecimal bytes", () => {
    expect(validateCredential("ab".repeat(32))).toEqual(Buffer.alloc(32, 0xab));
    expect(() => validateCredential("ab".repeat(31))).toThrow(/32 hexadecimal bytes/);
    expect(() => validateCredential("zz".repeat(32))).toThrow(/32 hexadecimal bytes/);
  });

  it("binds one-use authorization to a public key", () => {
    const session = new CredentialSession(Buffer.alloc(32, 7), "02aa", 1_000);
    expect(() => session.consume("02bb")).toThrow(/Unlock/);
    expect(session.matches("02aa")).toBe(false);
  });

  it("expires and consumes a credential only once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const session = new CredentialSession(Buffer.alloc(32, 9), "02aa", 1_000);
    const credential = session.consume("02aa");
    expect(credential).toEqual(Buffer.alloc(32, 9));
    credential.fill(0);
    expect(() => session.consume("02aa")).toThrow(/Unlock/);

    const expired = new CredentialSession(Buffer.alloc(32, 3), "02aa", 1_000);
    vi.advanceTimersByTime(1_001);
    expect(() => expired.consume("02aa")).toThrow(/Unlock/);
  });
});

describe("network numeric guards", () => {
  it("rejects signs, decimals and non-digits", () => {
    expect(assertUnsignedDecimal("123", "value")).toBe("123");
    for (const value of ["-1", "+1", "1.0", "1e2", "NaN"]) {
      expect(() => assertUnsignedDecimal(value, "value")).toThrow(/Malformed/);
    }
    expect(() => assertUnsignedDecimal("1".repeat(79), "value")).toThrow(/Malformed/);
  });

  it("converts display amounts within the chain Uint128 range", () => {
    expect(displayAmountToUint128("1.25")).toBe("1250000000000000000");
    expect(() => displayAmountToUint128("0")).toThrow(/greater than zero/);
    expect(() => displayAmountToUint128("1.0000000000000000001")).toThrow(/at most 18 decimals/);
    expect(() => displayAmountToUint128(((1n << 128n) / 10n ** 18n + 1n).toString())).toThrow(/supported range/);
  });

  it("accepts only randomUUID-shaped v4 review identifiers", () => {
    expect(validateReviewId("123e4567-e89b-42d3-a456-426614174000", "transfer")).toContain("42d3");
    for (const value of ["123e4567-e89b-12d3-a456-426614174000", "-".repeat(36), "123e4567e89b42d3a456426614174000"]) {
      expect(() => validateReviewId(value, "transfer")).toThrow(/valid transfer review/);
    }
  });
});
