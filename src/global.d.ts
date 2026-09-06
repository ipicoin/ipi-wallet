type NetworkStatus = {
  checkedAt: string;
  cosmos: { online: boolean; height: number | null; error: string | null };
  evm: { online: boolean; height: number | null; error: string | null };
};

interface Window {
  ipiDesktop: {
    getNetworkStatus(): Promise<NetworkStatus>;
    openExternal(url: string): Promise<void>;
    getWalletStatus(): Promise<{ account: AccountStatus; chains: Record<"ethereum" | "bitcoin", ChainAccountStatus> }>;
    initializeChain(chain: "ethereum" | "bitcoin", credential: string, recoveryCredential: string, expectedSalt: string | null): Promise<ChainAccountStatus>;
    recoverChainPassword(chain: "ethereum" | "bitcoin", recoveryCredential: string, nextCredential: string, expectedSalt: string | null): Promise<ChainAccountStatus>;
    unlockChain(chain: "ethereum" | "bitcoin", credential: string, expectedSalt: string | null): Promise<ChainAccountStatus>;
    changeChainPassword(chain: "ethereum" | "bitcoin", currentCredential: string, nextCredential: string, expectedSalt: string | null): Promise<ChainAccountStatus>;
    lockChain(chain: "ethereum" | "bitcoin"): Promise<ChainAccountStatus>;
    getChainBalance(chain: "ethereum" | "bitcoin", address: string): Promise<{ chain: "ethereum" | "bitcoin"; address: string; amount: string }>;
    initializeCard(credential: string, recoveryCredential: string, expectedSalt: string | null): Promise<AccountStatus>;
    recoverCardPassword(recoveryCredential: string, nextCredential: string, expectedSalt: string | null): Promise<AccountStatus>;
    unlockCard(credential: string, expectedSalt: string | null): Promise<AccountStatus>;
    changeCardPassword(currentCredential: string, nextCredential: string, expectedSalt: string | null): Promise<AccountStatus>;
    lockCard(): Promise<AccountStatus>;
    onCardChanged(callback: () => void): () => void;
    getBalance(address: string): Promise<{ address: string; amount: string }>;
    reviewSend(recipient: string, amount: string): Promise<SendReview>;
    executeSend(reviewId: string): Promise<SendResult>;
    getVaultConfiguration(): Promise<{ available: boolean; codeId: string | null; chainId: string }>;
    getVaultStatus(contractAddress: string): Promise<VaultStatus>;
    reviewVaultCreate(): Promise<VaultReview>;
    reviewVaultInvite(contractAddress: string, cardAddress: string): Promise<VaultReview>;
    reviewVaultAccept(contractAddress: string): Promise<VaultReview>;
    reviewVaultCancel(contractAddress: string, cardAddress: string): Promise<VaultReview>;
    reviewVaultRemove(contractAddress: string, cardAddress: string): Promise<VaultReview>;
    reviewVaultTransfer(contractAddress: string, recipient: string, amount: string): Promise<VaultReview>;
    executeVaultAction(reviewId: string): Promise<VaultResult>;
  };
}

type CardSecurity = { supported: boolean; state: string; triesRemaining: number | null; retryLimit: number | null; recoverySupported: boolean; recoveryTriesRemaining: number | null; recoveryRetryLimit: number | null };
type AccountStatus = { exists: boolean; installed: boolean; cardConnected: boolean; address: string | null; publicKey: string | null; reader: string; profile: string; credentialSalt: string | null; security: CardSecurity; unlocked: boolean };
type ChainAccountStatus = { chain: "ethereum" | "bitcoin"; installed: boolean; initialized: boolean; address: string | null; publicKey: string | null; reader: string; profile: string; credentialSalt: string | null; authCounter: number | null; security: CardSecurity; unlocked: boolean };
type SendReview = { reviewId: string; expiresAt: string; sender: string; recipient: string; amount: string; fee: string; balance: string; chainId: string };
type SendResult = SendReview & { txHash: string; height: string; balanceBefore: string; balanceAfter: string; balanceDeltaMatches: boolean; signatureVerified: boolean };
type VaultMember = { address: string };
type VaultInvitation = { address: string };
type VaultStatus = { contractAddress: string; codeId: string; balance: string; memberCount: number; currentMember: VaultMember | null; currentInvitation: VaultInvitation | null; members: VaultMember[]; invitations: VaultInvitation[] };
type VaultReview = { reviewId: string; expiresAt: string; action: "create" | "invite" | "accept" | "cancel" | "remove" | "transfer"; signer: string; contractAddress: string | null; target: string | null; amount: string | null; fee: string; feeGranter: string | null; controllerBalance: string; vaultBalance: string | null; chainId: string; codeId: string };
type VaultResult = VaultReview & { txHash: string; height: string; contractAddress: string; signatureVerified: boolean };
