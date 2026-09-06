import { contextBridge, ipcRenderer } from "electron";

export type NetworkStatus = {
  checkedAt: string;
  cosmos: { online: boolean; height: number | null; error: string | null };
  evm: { online: boolean; height: number | null; error: string | null };
};

export type CardSecurity = { supported: boolean; state: string; triesRemaining: number | null; retryLimit: number | null; recoverySupported: boolean; recoveryTriesRemaining: number | null; recoveryRetryLimit: number | null };
export type AccountStatus = { exists: boolean; installed: boolean; cardConnected: boolean; address: string | null; publicKey: string | null; reader: string; profile: string; credentialSalt: string | null; security: CardSecurity; unlocked: boolean };
export type ChainAccountStatus = { chain: "ethereum" | "bitcoin"; installed: boolean; initialized: boolean; address: string | null; publicKey: string | null; reader: string; profile: string; credentialSalt: string | null; authCounter: number | null; security: CardSecurity; unlocked: boolean };
export type VaultMember = { address: string };
export type VaultInvitation = { address: string };
export type VaultStatus = { contractAddress: string; codeId: string; balance: string; memberCount: number; currentMember: VaultMember | null; currentInvitation: VaultInvitation | null; members: VaultMember[]; invitations: VaultInvitation[] };

contextBridge.exposeInMainWorld("ipiDesktop", Object.freeze({
  getNetworkStatus: (): Promise<NetworkStatus> => ipcRenderer.invoke("network:status"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("external:open", url),
  copyAddress: (address: string): Promise<void> => ipcRenderer.invoke("clipboard:write-address", address),
  getWalletStatus: (): Promise<{ account: AccountStatus; chains: Record<"ethereum" | "bitcoin", ChainAccountStatus> }> => ipcRenderer.invoke("wallet:status"),
  logout: (): Promise<{ closed: boolean }> => ipcRenderer.invoke("wallet:logout"),
  initializeChain: (chain: "ethereum" | "bitcoin", credential: string, recoveryCredential: string, expectedSalt: string | null): Promise<ChainAccountStatus> => ipcRenderer.invoke("chains:initialize", chain, credential, recoveryCredential, expectedSalt),
  recoverChainPassword: (chain: "ethereum" | "bitcoin", recoveryCredential: string, nextCredential: string, expectedSalt: string | null): Promise<ChainAccountStatus> => ipcRenderer.invoke("chains:recover", chain, recoveryCredential, nextCredential, expectedSalt),
  unlockChain: (chain: "ethereum" | "bitcoin", credential: string, expectedSalt: string | null): Promise<ChainAccountStatus> => ipcRenderer.invoke("chains:unlock", chain, credential, expectedSalt),
  changeChainPassword: (chain: "ethereum" | "bitcoin", currentCredential: string, nextCredential: string, expectedSalt: string | null): Promise<ChainAccountStatus> => ipcRenderer.invoke("chains:change-password", chain, currentCredential, nextCredential, expectedSalt),
  lockChain: (chain: "ethereum" | "bitcoin"): Promise<ChainAccountStatus> => ipcRenderer.invoke("chains:lock", chain),
  getChainBalance: (chain: "ethereum" | "bitcoin", address: string): Promise<{ chain: "ethereum" | "bitcoin"; address: string; amount: string }> => ipcRenderer.invoke("chains:balance", chain, address),
  initializeCard: (credential: string, recoveryCredential: string, expectedSalt: string | null): Promise<AccountStatus> => ipcRenderer.invoke("account:initialize-card", credential, recoveryCredential, expectedSalt),
  recoverCardPassword: (recoveryCredential: string, nextCredential: string, expectedSalt: string | null): Promise<AccountStatus> => ipcRenderer.invoke("security:recover", recoveryCredential, nextCredential, expectedSalt),
  unlockCard: (credential: string, expectedSalt: string | null): Promise<AccountStatus> => ipcRenderer.invoke("security:unlock", credential, expectedSalt),
  changeCardPassword: (currentCredential: string, nextCredential: string, expectedSalt: string | null): Promise<AccountStatus> => ipcRenderer.invoke("security:change-password", currentCredential, nextCredential, expectedSalt),
  lockCard: (): Promise<AccountStatus> => ipcRenderer.invoke("security:lock"),
  onCardChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("card:changed", listener);
    return () => ipcRenderer.removeListener("card:changed", listener);
  },
  onSecurityLocked: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("security:locked", listener);
    return () => ipcRenderer.removeListener("security:locked", listener);
  },
  getBalance: (address: string): Promise<{ address: string; amount: string }> => ipcRenderer.invoke("account:balance", address),
  reviewSend: (recipient: string, amount: string) => ipcRenderer.invoke("send:review", recipient, amount),
  executeSend: (reviewId: string) => ipcRenderer.invoke("send:execute", reviewId),
  getVaultConfiguration: (): Promise<VaultConfiguration> => ipcRenderer.invoke("vault:configuration"),
  getVaultStatus: (contractAddress: string): Promise<VaultStatus> => ipcRenderer.invoke("vault:status", contractAddress),
  getVaultRelayPoolStatus: (contractAddress: string, relays: string[]): Promise<{ vault: string; relays: string[] }> => ipcRenderer.invoke("vault:relay-pool-status", contractAddress, relays),
  reviewVaultCreate: (): Promise<VaultReview> => ipcRenderer.invoke("vault:review-create"),
  reviewVaultInvite: (contractAddress: string, cardAddress: string): Promise<VaultReview> => ipcRenderer.invoke("vault:review-invite", contractAddress, cardAddress),
  reviewVaultAccept: (contractAddress: string): Promise<VaultReview> => ipcRenderer.invoke("vault:review-accept", contractAddress),
  reviewVaultCancel: (contractAddress: string, cardAddress: string): Promise<VaultReview> => ipcRenderer.invoke("vault:review-cancel", contractAddress, cardAddress),
  reviewVaultRemove: (contractAddress: string, cardAddress: string): Promise<VaultReview> => ipcRenderer.invoke("vault:review-remove", contractAddress, cardAddress),
  reviewVaultRelaySetup: (contractAddress: string): Promise<VaultReview> => ipcRenderer.invoke("vault:review-setup-relays", contractAddress),
  reviewVaultRelayTransfer: (contractAddress: string, relays: string[], recipient: string, amount: string): Promise<VaultReview> => ipcRenderer.invoke("vault:review-relay-transfer", contractAddress, relays, recipient, amount),
  executeVaultAction: (reviewId: string): Promise<VaultResult> => ipcRenderer.invoke("vault:execute", reviewId),
}));

export type VaultConfiguration = { available: boolean; codeId: string | null; chainId: string; relayAvailable: boolean; relayCodeId: string | null; relayCount: number };
export type VaultReview = { reviewId: string; expiresAt: string; action: "create" | "invite" | "accept" | "cancel" | "remove" | "setup-relays" | "relay-transfer"; signer: string; contractAddress: string | null; target: string | null; amount: string | null; fee: string; feeGranter: string | null; controllerBalance: string; vaultBalance: string | null; chainId: string; codeId: string; relayCodeId?: string; route?: string[]; paymentId?: string };
export type VaultResult = VaultReview & { txHash: string; height: string; contractAddress: string; relayAddresses?: string[]; signatureVerified: boolean };
