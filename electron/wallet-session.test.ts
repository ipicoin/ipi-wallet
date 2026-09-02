import { describe, expect, it } from "vitest";
import { PublicWalletSession, type SessionAccountStatus, type SessionChainStatus } from "./wallet-session.js";

const security = {
  supported: true,
  state: "ready",
  triesRemaining: 10,
  retryLimit: 10,
  recoverySupported: true,
  recoveryTriesRemaining: 10,
  recoveryRetryLimit: 10,
};

function account(publicKey = "02aa"): SessionAccountStatus {
  return {
    exists: true,
    installed: true,
    cardConnected: true,
    address: `ipi1${publicKey}`,
    publicKey,
    reader: "Reader 0",
    profile: "secure-v3",
    credentialSalt: "ab".repeat(16),
    security,
    unlocked: true,
  };
}

function chain(chainName: "ethereum" | "bitcoin"): SessionChainStatus {
  return {
    chain: chainName,
    installed: true,
    initialized: true,
    address: chainName === "ethereum" ? "0xabc" : "bc1abc",
    publicKey: "03bb",
    reader: "Reader 0",
    profile: `${chainName}-mainnet-v2`,
    credentialSalt: "cd".repeat(16),
    authCounter: 3,
    security,
    unlocked: true,
  };
}

describe("public wallet session", () => {
  it("keeps public identity data after card removal without keeping unlock state", () => {
    const session = new PublicWalletSession();
    session.rememberAccount(account());
    session.rememberChain(chain("ethereum"));

    expect(session.account()).toMatchObject({ exists: true, cardConnected: false, publicKey: "02aa", unlocked: false });
    expect(session.chain("ethereum")).toMatchObject({ initialized: true, publicKey: "03bb", unlocked: false });
  });

  it("drops cached profiles when a different IPI card opens the session", () => {
    const session = new PublicWalletSession();
    expect(session.rememberAccount(account("02aa"))).toBe(false);
    session.rememberChain(chain("bitcoin"));

    expect(session.rememberAccount(account("02cc"))).toBe(true);
    expect(session.account()?.publicKey).toBe("02cc");
    expect(session.chain("bitcoin")).toBeNull();
  });

  it("treats a changed card credential salt as a different identity", () => {
    const session = new PublicWalletSession();
    session.rememberAccount(account());
    session.rememberChain(chain("ethereum"));

    expect(session.rememberAccount({ ...account(), credentialSalt: "ef".repeat(16) })).toBe(true);
    expect(session.chain("ethereum")).toBeNull();
  });

  it("clears the session for a connected factory-state card", () => {
    const session = new PublicWalletSession();
    session.rememberAccount(account());

    expect(session.rememberAccount({ ...account(), exists: false, address: null, publicKey: null })).toBe(true);
    expect(session.account()).toBeNull();
  });
});
