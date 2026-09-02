export type SessionAccountStatus = {
  exists: boolean;
  installed: boolean;
  cardConnected: boolean;
  address: string | null;
  publicKey: string | null;
  reader: string;
  profile: string;
  credentialSalt: string | null;
  security: {
    supported: boolean;
    state: string;
    triesRemaining: number | null;
    retryLimit: number | null;
    recoverySupported: boolean;
    recoveryTriesRemaining: number | null;
    recoveryRetryLimit: number | null;
  };
  unlocked: boolean;
};

export type SessionChainStatus = {
  chain: "ethereum" | "bitcoin";
  installed: boolean;
  initialized: boolean;
  address: string | null;
  publicKey: string | null;
  reader: string;
  profile: string;
  credentialSalt: string | null;
  authCounter: number | null;
  security: SessionAccountStatus["security"];
  unlocked: boolean;
};

/**
 * Keeps only public wallet identity data for the lifetime of this process.
 * Password-derived credentials and private keys never enter this session.
 */
export class PublicWalletSession {
  #account: SessionAccountStatus | null = null;
  #chains: Partial<Record<SessionChainStatus["chain"], SessionChainStatus>> = {};

  rememberAccount(account: SessionAccountStatus): boolean {
    if (!account.exists || !account.address || !account.publicKey) {
      return this.clear();
    }
    const identityChanged = this.#account !== null && (
      this.#account.publicKey !== account.publicKey
      || this.#account.credentialSalt !== account.credentialSalt
    );
    if (identityChanged) this.#chains = {};
    this.#account = { ...account, cardConnected: false, unlocked: false };
    return identityChanged;
  }

  rememberChain(account: SessionChainStatus): void {
    if (!this.#account) return;
    this.#chains[account.chain] = { ...account, unlocked: false };
  }

  account(): SessionAccountStatus | null {
    return this.#account ? { ...this.#account, cardConnected: false, unlocked: false } : null;
  }

  chain(chain: SessionChainStatus["chain"]): SessionChainStatus | null {
    const account = this.#chains[chain];
    return account ? { ...account, unlocked: false } : null;
  }

  forgetChain(chain: SessionChainStatus["chain"]): void {
    delete this.#chains[chain];
  }

  clear(): boolean {
    const hadIdentity = this.#account !== null || Object.keys(this.#chains).length > 0;
    this.#account = null;
    this.#chains = {};
    return hadIdentity;
  }
}
