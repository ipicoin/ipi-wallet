import "./styles.css";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import QRCode from "qrcode";

type ThemeName = "dark" | "light";
const previewTheme = new URLSearchParams(location.search).get("theme");
const savedTheme = localStorage.getItem("ipi-wallet-theme");
let theme: ThemeName = previewTheme === "light" || (previewTheme !== "dark" && savedTheme === "light") ? "light" : "dark";
document.documentElement.dataset.theme = theme;

// Browser-only preview used by Vite and visual regression screenshots. The
// packaged Electron app always receives the real, isolated API from preload.
if (!window.ipiDesktop) {
  const previewAllowed = location.protocol === "http:" && location.hostname === "127.0.0.1" && location.port === "5173";
  if (!previewAllowed) throw new Error("The secure IPI Wallet desktop bridge is unavailable");
  window.ipiDesktop = {
    getNetworkStatus: async () => ({ checkedAt: new Date().toISOString(), cosmos: { online: true, height: 388873, error: null }, evm: { online: true, height: 388873, error: null } }),
    openExternal: async (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    copyAddress: async (address) => navigator.clipboard.writeText(address),
    logout: async () => ({ closed: true }),
    getWalletStatus: async () => ({
      account: { exists: false, installed: false, cardConnected: false, address: null, publicKey: null, reader: "Browser preview", profile: "none", credentialSalt: null, security: { supported: false, state: "disconnected", triesRemaining: null, retryLimit: null, recoverySupported: false, recoveryTriesRemaining: null, recoveryRetryLimit: null }, unlocked: false },
      chains: {
        ethereum: { chain: "ethereum", installed: false, initialized: false, address: null, publicKey: null, reader: "Browser preview", profile: "none", credentialSalt: null, authCounter: null, security: { supported: false, state: "unavailable", triesRemaining: null, retryLimit: null, recoverySupported: false, recoveryTriesRemaining: null, recoveryRetryLimit: null }, unlocked: false },
        bitcoin: { chain: "bitcoin", installed: false, initialized: false, address: null, publicKey: null, reader: "Browser preview", profile: "none", credentialSalt: null, authCounter: null, security: { supported: false, state: "unavailable", triesRemaining: null, retryLimit: null, recoverySupported: false, recoveryTriesRemaining: null, recoveryRetryLimit: null }, unlocked: false },
      },
    }),
    initializeChain: async () => { throw new Error("Chain initialization is available in the Linux application"); },
    recoverChainPassword: async () => { throw new Error("Card recovery is available in the Linux application"); },
    unlockChain: async () => { throw new Error("Card security is available in the Linux application"); },
    changeChainPassword: async () => { throw new Error("Card security is available in the Linux application"); },
    lockChain: async () => { throw new Error("Card security is available in the Linux application"); },
    getChainBalance: async (chain, address) => ({ chain, address, amount: "0" }),
    initializeCard: async () => { throw new Error("Card initialization is available in the Linux application"); },
    recoverCardPassword: async () => { throw new Error("Card recovery is available in the Linux application"); },
    unlockCard: async () => { throw new Error("Card security is available in the Linux application"); },
    changeCardPassword: async () => { throw new Error("Card security is available in the Linux application"); },
    lockCard: async () => { throw new Error("Card security is available in the Linux application"); },
    onCardChanged: () => () => undefined,
    onSecurityLocked: () => () => undefined,
    getBalance: async (address) => ({ address, amount: "0" }),
    reviewSend: async () => { throw new Error("Send is available in the Linux application"); },
    executeSend: async () => { throw new Error("Send is available in the Linux application"); },
    getVaultConfiguration: async () => ({ available: false, codeId: null, chainId: "ipi-testnet-1", relayAvailable: false, relayCodeId: null, relayCount: 5 }),
    getVaultStatus: async () => { throw new Error("Card Vault is available in the Linux application"); },
    getVaultRelayPoolStatus: async () => { throw new Error("Payment relays are available in the Linux application"); },
    reviewVaultCreate: async () => { throw new Error("Card Vault is available in the Linux application"); },
    reviewVaultInvite: async () => { throw new Error("Card Vault is available in the Linux application"); },
    reviewVaultAccept: async () => { throw new Error("Card Vault is available in the Linux application"); },
    reviewVaultCancel: async () => { throw new Error("Card Vault is available in the Linux application"); },
    reviewVaultRemove: async () => { throw new Error("Card Vault is available in the Linux application"); },
    reviewVaultRelaySetup: async () => { throw new Error("Payment relays are available in the Linux application"); },
    reviewVaultRelayTransfer: async () => { throw new Error("Payment relays are available in the Linux application"); },
    executeVaultAction: async () => { throw new Error("Card Vault is available in the Linux application"); },
  };
}

type ViewName = "overview" | "send-card" | "receive-card" | "vault" | "send-vault" | "receive-vault" | "cards" | "checkout" | "hardware" | "security" | "settings";
type AssetSelector = "ipi" | "ethereum" | "bitcoin";
let account: AccountStatus = { exists: false, installed: false, cardConnected: false, address: null, publicKey: null, reader: "", profile: "none", credentialSalt: null, security: { supported: false, state: "disconnected", triesRemaining: null, retryLimit: null, recoverySupported: false, recoveryTriesRemaining: null, recoveryRetryLimit: null }, unlocked: false };
const unavailableChain = (chain: "ethereum" | "bitcoin"): ChainAccountStatus => ({ chain, installed: false, initialized: false, address: null, publicKey: null, reader: "", profile: "none", credentialSalt: null, authCounter: null, security: { supported: false, state: "unavailable", triesRemaining: null, retryLimit: null, recoverySupported: false, recoveryTriesRemaining: null, recoveryRetryLimit: null }, unlocked: false });
let chainAccounts: Record<"ethereum" | "bitcoin", ChainAccountStatus> = { ethereum: unavailableChain("ethereum"), bitcoin: unavailableChain("bitcoin") };
let chainBalances: Record<"ethereum" | "bitcoin", string> = { ethereum: "0", bitcoin: "0" };
let selectedAsset: AssetSelector = "ipi";
let balanceAmount = "0";
let pendingSend: { recipient: string; amount: string; review: SendReview } | null = null;
let pendingVaultAction: { fingerprint: string; review: VaultReview } | null = null;
let vaultConfiguration: VaultConfiguration = { available: false, codeId: null, chainId: "ipi-testnet-1", relayAvailable: false, relayCodeId: null, relayCount: 5 };
let vaultAddress = localStorage.getItem("ipi-card-vault-address");
let vaultRelayAddresses: string[] = [];
let vaultStatus: VaultStatus | null = null;
let vaultError = "";
let vaultRefreshInProgress = false;
let lastVaultRefresh = 0;
let lastVaultCardAddress: string | null = null;
let balanceRefreshInProgress = false;
let chainBalanceRefreshInProgress = false;
let cardRecoveryInProgress = false;
let securityToast = "";
let securityToastTimer: number | undefined;
const BALANCE_REFRESH_INTERVAL_MS = 5_000;
const CARD_RECOVERY_INTERVAL_MS = 3_000;
const REVIEW_EXECUTION_MARGIN_MS = 5_000;

function relayStorageKey(address: string): string {
  return `ipi-payment-relays:${address}`;
}

function loadRelayAddresses(address: string | null): string[] {
  if (!address) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(relayStorageKey(address)) ?? "[]");
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : [];
  } catch {
    return [];
  }
}

vaultRelayAddresses = loadRelayAddresses(vaultAddress);

const links = Object.freeze({
  explorer: "https://scan.ipi.io/",
  faucet: "https://faucet-testnet.ipi.io/",
  status: "https://status-testnet.ipi.io/",
  webWallet: "https://wallet.ipi.io/",
});

const viewCopy: Record<ViewName, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: "PORTFOLIO", title: "Your wallet", description: "Assets authorized by your IPI Card." },
  "send-card": { eyebrow: "CARD TRANSFER", title: "Send from card", description: "Spend only the balance of this physical card's IPI address." },
  "receive-card": { eyebrow: "CARD ACCOUNT", title: "Receive on card", description: "The public addresses derived from the active physical card." },
  vault: { eyebrow: "SHARED ACCOUNT", title: "Vault", description: "The shared account is shown only while the IPI Card is unlocked." },
  "send-vault": { eyebrow: "VAULT TRANSFER", title: "Send from vault", description: "Pay through the vault's five transparent payment relays." },
  "receive-vault": { eyebrow: "VAULT ACCOUNT", title: "Receive on vault", description: "Fund the shared CosmWasm account directly." },
  cards: { eyebrow: "MEMBERSHIP", title: "Cards", description: "Active equal cards and invitations for this vault." },
  checkout: { eyebrow: "IPI CHECKOUT V2", title: "Approve the complete operation.", description: "Merchant, products, amount and ownership should be visible before approval." },
  hardware: { eyebrow: "SECURE ELEMENT", title: "IPI Card", description: "Independent card-only keys for each supported network." },
  security: { eyebrow: "CARD ACCESS", title: "Security", description: "Unlock the card or change its password-protected credential." },
  settings: { eyebrow: "APPLICATION", title: "Settings", description: "Network, privacy and developer options." },
};

const navItems: Array<{ id: ViewName; icon: string; label: string }> = [
  { id: "overview", icon: "⌂", label: "Overview" },
  { id: "send-card", icon: "↗", label: "Send from card" },
  { id: "receive-card", icon: "↙", label: "Receive on card" },
  { id: "vault", icon: "◇", label: "Vault" },
  { id: "send-vault", icon: "⇢", label: "Send from vault" },
  { id: "receive-vault", icon: "⇠", label: "Receive on vault" },
  { id: "cards", icon: "⊕", label: "Cards" },
  { id: "checkout", icon: "◫", label: "Checkout" },
  { id: "hardware", icon: "⌁", label: "IPI Card" },
  { id: "security", icon: "◆", label: "Security" },
  { id: "settings", icon: "⚙", label: "Settings" },
];

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root is missing");

app.innerHTML = `
  <div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><img src="./ipi-logo.svg" alt="IPI"><div><strong>IPI Wallet</strong><small>Card-only desktop</small></div></div>
      <nav>${navItems.map((item) => `<button class="nav-item${item.id === "overview" ? " active" : ""}" data-view="${item.id}"><span>${item.icon}</span>${item.label}</button>`).join("")}</nav>
      <div class="session-card"><strong id="card-status">Connect card</strong><button class="text-button" id="logout" type="button">Logout</button></div>
      <div class="network-card"><div><i class="live-dot" id="network-dot"></i><span id="network-label">Checking network</span></div><strong>42424</strong><small>EVM chain ID · IPI Testnet</small></div>
      <div class="sidebar-links"><button data-external="status">Status</button><button data-external="webWallet">Web Wallet</button></div>
    </aside>
    <main class="workspace">
      <header class="topbar"><div><strong>IPI Wallet</strong><small>IPI Testnet · Ethereum Mainnet · Bitcoin Mainnet</small></div><div class="top-actions"><button class="theme-toggle" id="theme-toggle" type="button" title="Change appearance"><span class="theme-sun">☀</span><span class="theme-moon">☾</span></button><span class="testnet-pill">MIXED NETWORKS</span></div></header>
      <section class="content">
        <div class="page-heading"><div><p id="eyebrow">IPI WALLET</p><h1 id="page-title">Your wallet, built around proof.</h1><span id="page-description">Independent card-only accounts for supported networks.</span></div><button class="icon-button" id="refresh" title="Refresh network">↻</button></div>
        <div id="view-root"></div>
      </section>
    </main>
  </div>
  <dialog id="account-dialog"><form method="dialog" id="account-form"><button class="dialog-close" id="dialog-close" type="button" aria-label="Close">×</button><span class="tag">ONE PASSWORD · THREE CURRENCIES</span><h2 id="dialog-title">Initialize secure IPI Card</h2><p id="dialog-copy">One Card Password and one Recovery Password protect all three isolated card profiles.</p><label>Card Password<input id="initialize-password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label>Repeat Card Password<input id="initialize-password-repeat" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label>Recovery Password<input id="initialize-recovery-password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label>Repeat Recovery Password<input id="initialize-recovery-password-repeat" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><div class="notice warning"><span>!</span><div><strong>Keep the Recovery Password offline</strong><p>Each password has 10 attempts per isolated profile. Recovery resets only card access; private keys never leave the card.</p></div></div><div class="dialog-error" id="dialog-error"></div><button class="button primary wide" id="dialog-submit" value="default">Initialize all profiles</button></form></dialog>`;

const viewRoot = document.querySelector<HTMLDivElement>("#view-root")!;
const formatHeight = (height: number | null) => height === null ? "Unavailable" : height.toLocaleString("en-US");
const formatIpi = (amount: string): string => {
  const padded = amount.padStart(19, "0");
  const whole = padded.slice(0, -18).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-18).replace(/0+$/, "").slice(0, 6);
  return `${whole}${fraction ? `.${fraction}` : ""} IPI`;
};
const formatUsd = (amount: string): string => {
  const baseUnits = BigInt(amount);
  const basePerIpi = 10n ** 18n;
  const cents = (baseUnits * 200n + basePerIpi / 2n) / basePerIpi;
  const dollars = cents / 100n;
  return `$${dollars.toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")} USD`;
};
const formatUnits = (amount: string, decimals: number, symbol: string, visibleDecimals = 6): string => {
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-decimals).replace(/0+$/, "").slice(0, visibleDecimals);
  return `${whole}${fraction ? `.${fraction}` : ""} ${symbol}`;
};
const formatEth = (amount: string): string => formatUnits(amount, 18, "ETH");
const formatBtc = (amount: string): string => formatUnits(amount, 8, "BTC", 8);

function activeMemberVault(): VaultStatus | null {
  return vaultStatus?.currentMember ? vaultStatus : null;
}

function assetDetails(asset: AssetSelector = selectedAsset) {
  if (asset === "ipi") {
    return {
    asset, symbol: "IPI", name: "IPI", network: "IPI Public Testnet · Personal card", chain: "ipi-testnet-1",
    initialized: account.exists, installed: account.installed, address: account.address,
    balance: balanceAmount, formattedBalance: account.exists ? formatIpi(balanceAmount) : "— IPI",
    profile: account.profile, credentialSalt: account.credentialSalt, security: account.security, unlocked: account.unlocked,
    };
  }
  const chain = chainAccounts[asset];
  const isEthereum = asset === "ethereum";
  return {
    asset, symbol: isEthereum ? "ETH" : "BTC", name: isEthereum ? "Ethereum" : "Bitcoin",
    network: isEthereum ? "Ethereum Mainnet" : "Bitcoin Mainnet", chain: isEthereum ? "1" : "Bitcoin",
    initialized: chain.initialized, installed: chain.installed, address: chain.address,
    balance: chainBalances[asset], formattedBalance: chain.initialized ? (isEthereum ? formatEth(chainBalances.ethereum) : formatBtc(chainBalances.bitcoin)) : `— ${isEthereum ? "ETH" : "BTC"}`,
    profile: chain.profile, credentialSalt: chain.credentialSalt, security: chain.security, unlocked: chain.unlocked,
  };
}
const allWalletAppletsInstalled = (): boolean => account.installed && chainAccounts.ethereum.installed && chainAccounts.bitcoin.installed;
const shortAddress = (address: string | null): string => address ? `${address.slice(0, 10)}…${address.slice(-7)}` : "No account connected";
const textEncoder = new TextEncoder();

function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("Card returned invalid hexadecimal data");
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveCardCredential(rawPassword: string, profile = account.profile, credentialSalt = account.credentialSalt, purpose: "primary" | "recovery" = "primary"): Promise<string> {
  const normalizedPassword = rawPassword.normalize("NFKC");
  if (normalizedPassword.length < 10 || normalizedPassword.length > 128) throw new Error("Password must contain 10 to 128 normalized characters");
  let salt = textEncoder.encode("IPI_CARD_PASSWORD_V1");
  if (["secure-v2", "secure-v3", "ethereum-mainnet-v1", "ethereum-mainnet-v2", "bitcoin-mainnet-v1", "bitcoin-mainnet-v2"].includes(profile)) {
    if (!credentialSalt || !/^[0-9a-f]{32}$/i.test(credentialSalt)) throw new Error("Secure card returned an invalid credential salt");
    const primaryDomains: Record<string, string> = {
      "secure-v2": "IPI_CARD_PASSWORD_V2\0",
      "secure-v3": "IPI_CARD_PASSWORD_V2\0",
      "ethereum-mainnet-v1": "IPI_CARD_ETH_MAINNET_PASSWORD_V1\0",
      "ethereum-mainnet-v2": "IPI_CARD_ETH_MAINNET_PASSWORD_V1\0",
      "bitcoin-mainnet-v1": "IPI_CARD_BTC_MAINNET_PASSWORD_V1\0",
      "bitcoin-mainnet-v2": "IPI_CARD_BTC_MAINNET_PASSWORD_V1\0",
    };
    const recoveryDomains: Record<string, string> = {
      "secure-v3": "IPI_CARD_RECOVERY_PASSWORD_V1\0",
      "ethereum-mainnet-v2": "IPI_CARD_ETH_MAINNET_RECOVERY_PASSWORD_V1\0",
      "bitcoin-mainnet-v2": "IPI_CARD_BTC_MAINNET_RECOVERY_PASSWORD_V1\0",
    };
    const domainName = purpose === "recovery" ? recoveryDomains[profile] : primaryDomains[profile];
    if (!domainName) throw new Error("This card profile does not support a Recovery Password");
    const domain = textEncoder.encode(domainName);
    const cardSalt = hexToBytes(credentialSalt);
    salt = new Uint8Array(domain.length + cardSalt.length);
    salt.set(domain); salt.set(cardSalt, domain.length);
  } else if (profile !== "secure-v1") {
    throw new Error("Unsupported card credential profile");
  }
  const passwordBytes = textEncoder.encode(normalizedPassword);
  try {
    const credential = await scryptAsync(passwordBytes, salt, { N: 65_536, r: 8, p: 1, dkLen: 32, maxmem: 128 * 1024 * 1024 });
    try { return bytesToHex(credential); }
    finally { credential.fill(0); }
  } finally {
    passwordBytes.fill(0);
  }
}

// Values read from PC/SC, IPC or network responses must never become markup.
// The renderer uses templates for layout, so every dynamic text value crossing
// one of those trust boundaries is encoded before it reaches innerHTML.
function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function notice(title: string, message: string): string {
  return `<div class="notice"><span>i</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div></div>`;
}

function signingCardNotice(): string {
  return account.exists && !account.cardConnected
    ? notice("View-only wallet session", "Balances and receive addresses stay available. Insert or tap the same IPI Card and unlock it before signing any operation.")
    : "";
}

function friendlyError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  const message = cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
  return `Error: ${message}`;
}

function renderReceiveQr(address: string): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#receive-qr");
  if (!canvas) return;
  void QRCode.toCanvas(canvas, address, {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 256,
    color: { dark: "#07101f", light: "#ffffff" },
  }).catch(() => {
    const frame = canvas.closest<HTMLElement>(".qr-frame");
    if (!frame) return;
    frame.classList.add("failed");
    frame.textContent = "Unable to generate QR code";
  });
}

function assetSwitcher(selected: AssetSelector): string {
  return `<div class="asset-switcher" role="tablist" aria-label="Card account">${(["ipi", "ethereum", "bitcoin"] as AssetSelector[]).map((asset) => {
    const details = assetDetails(asset);
    return `<button type="button" role="tab" class="${asset === selected ? "active" : ""}" aria-selected="${asset === selected}" data-asset-switch="${asset}">${details.symbol}<small>${details.network}</small></button>`;
  }).join("")}</div>`;
}

function assetRow(asset: AssetSelector): string {
  const details = assetDetails(asset);
  const iconClass = asset === "ipi" ? "" : ` ${asset}`;
  return `<button class="asset-row${selectedAsset === asset ? " selected" : ""}" data-asset="${asset}"><div class="asset-icon${iconClass}">${details.symbol.slice(0, 1)}</div><div><strong>${details.name}</strong><small>${details.network} · isolated key</small></div><div><strong id="asset-balance-${asset}">${escapeHtml(details.formattedBalance)}</strong><small>${details.initialized ? shortAddress(details.address) : details.installed ? "Ready to initialize" : "Applet unavailable"}</small></div></button>`;
}

function vaultMemberRows(status: VaultStatus): string {
  const rows = status.members.map((member) => {
    const active = member.address === account.address;
    const action = status.currentMember && status.memberCount > 1
      ? `<button class="text-button danger" type="button" data-vault-remove="${escapeHtml(member.address)}" ${account.cardConnected ? "" : "disabled"}>${active ? "Remove this card" : "Remove"}</button>`
      : '<span class="tag green">ACTIVE</span>';
    return `<div class="setting-row"><div><strong>${escapeHtml(shortAddress(member.address))}${active ? " · this card" : ""}</strong><span>Signing controller only · equal 1-of-${escapeHtml(status.memberCount)} authority<br>Use the shared address to receive IPI</span></div>${action}</div>`;
  }).join("");
  return rows || notice("No cards returned", "Refresh the vault state before continuing.");
}

function vaultInvitationRows(status: VaultStatus): string {
  if (status.invitations.length === 0) return "";
  const rows = status.invitations.map((invitation) => {
    const action = status.currentMember
      ? `<button class="text-button danger" type="button" data-vault-cancel="${escapeHtml(invitation.address)}" ${account.cardConnected ? "" : "disabled"}>Cancel</button>`
      : '<span class="tag">PENDING</span>';
    return `<div class="setting-row"><div><strong>${escapeHtml(shortAddress(invitation.address))}</strong><span>${escapeHtml(invitation.address)}<br>Waiting for this card to accept</span></div>${action}</div>`;
  }).join("");
  return `<h3>Pending invitations</h3>${rows}`;
}

function vaultUnlockNotice(): string {
  return `<div class="form-panel settings">${notice("Vault locked", "Open Security and enter the IPI Card Password. The vault address and balance remain hidden until this session is unlocked.")}<button class="button primary" type="button" data-go-security>Open Security</button></div>`;
}

function renderVaultView(): string {
  if (!account.exists || !account.address) {
    return notice("Insert an initialized IPI Card", "A card-derived IPI address is required to create or open a shared account.");
  }
  if (!account.unlocked) return vaultUnlockNotice();
  if (!vaultConfiguration.available) {
    return `${notice("Card Vault code is not deployed yet", "Build and store the audited CosmWasm contract, then configure its immutable on-chain code ID.")}<div class="form-panel settings"><h3>Contract verification</h3><p>The wallet accepts only immutable vault contracts matching the configured code ID.</p></div>`;
  }
  if (!vaultAddress) {
    return `<div class="section-grid"><form class="form-panel" id="vault-create-form"><h3>Create a shared IPI account</h3><p>This card becomes the first equal member. Adding another card later never creates card numbers or privileged roles.</p><div class="review" id="vault-review"><span>Contract code</span><strong>${escapeHtml(vaultConfiguration.codeId)}</strong><span>Upgrade administrator</span><strong>None · immutable</strong></div><div class="dialog-error" id="vault-error"></div><button class="button primary wide" id="vault-create-submit" ${account.cardConnected ? "" : "disabled"}>${account.cardConnected ? "Review vault creation" : "Insert or tap card to continue"}</button></form><form class="form-panel" id="vault-connect-form"><h3>Open an existing vault</h3><p>Use this on an invited card. The wallet verifies the contract code and its on-chain invitation.</p><label>Vault address<input id="vault-connect-address" autocomplete="off" spellcheck="false" placeholder="ipi1…" required></label><div class="dialog-error" id="vault-connect-error"></div><button class="button secondary wide">Verify and open</button></form></div>`;
  }
  if (!vaultStatus) {
    return `<div class="form-panel settings">${notice("Unable to open this vault", vaultError || "Vault state is loading.")}<button class="button secondary" id="vault-disconnect">Forget this vault address</button></div>`;
  }
  const role = vaultStatus.currentMember ? "ACTIVE CARD" : vaultStatus.currentInvitation ? "INVITED CARD" : "NOT AUTHORIZED";
  return `<div class="portfolio-card"><div class="portfolio-top"><div><span class="kicker">SHARED IPI BALANCE</span><div class="portfolio-value" id="vault-balance">${escapeHtml(formatIpi(vaultStatus.balance))}</div><small>${escapeHtml(vaultStatus.memberCount)} equal active ${vaultStatus.memberCount === 1 ? "card" : "cards"} · any one can authorize</small></div><span class="tag green">${role}</span></div><div class="portfolio-account"><div><span>Vault account address</span><code>${escapeHtml(vaultStatus.contractAddress)}</code></div><button class="text-button" id="vault-copy-address">Copy</button></div></div>`;
}

function renderCardsView(): string {
  if (!account.exists || !account.address) {
    return notice("Insert an initialized IPI Card", "An initialized card is required to manage vault membership.");
  }
  if (!account.unlocked) return vaultUnlockNotice();
  if (!vaultAddress) {
    return `<div class="form-panel settings">${notice("No vault is open", "Create or open the shared account in the Vault tab first.")}<button class="button primary" type="button" data-go-vault>Open Vault</button></div>`;
  }
  if (!vaultStatus) {
    return `<div class="form-panel settings">${notice("Unable to load vault membership", vaultError || "Vault state is loading.")}<button class="button secondary" id="vault-disconnect">Forget locally</button></div>`;
  }
  const status = vaultStatus;
  const invitationPanel = status.currentInvitation && !status.currentMember
    ? `<div class="form-panel"><h3>Accept invitation</h3><p>This physical card was invited to the vault. After acceptance it behaves exactly like every existing card.</p><div class="review" id="vault-review"><span>Authority after acceptance</span><strong>Full 1-of-${escapeHtml(status.memberCount + 1)}</strong></div><div class="dialog-error" id="vault-error"></div><button class="button primary wide" id="vault-accept" ${account.cardConnected ? "" : "disabled"}>${account.cardConnected ? "Review acceptance" : "Insert or tap card to continue"}</button></div>`
    : "";
  const managementPanel = status.currentMember
    ? `<form class="form-panel" id="vault-invite-form"><h3>Add another equal card</h3><p>The new card becomes active only after signing its own acceptance. It receives no number or special role.</p><label>New card IPI controller address<input id="vault-invite-address" autocomplete="off" spellcheck="false" placeholder="ipi1…" required></label><div class="review" id="vault-review"><span>Result</span><strong>New full 1-of-N member after acceptance</strong></div><div class="dialog-error" id="vault-error"></div><button class="button primary wide" id="vault-invite-submit" ${account.cardConnected ? "" : "disabled"}>${account.cardConnected ? "Review invitation" : "Insert or tap card to continue"}</button></form>`
    : `${notice("This card is not authorized", "It has neither active membership nor a valid invitation for this shared account.")}`;
  return `<div class="section-grid"><div class="form-panel settings"><h3>Active cards</h3>${vaultMemberRows(status)}${vaultInvitationRows(status)}${status.memberCount > status.members.length ? `<p>Showing the first ${escapeHtml(status.members.length)} cards. Membership itself has no fixed contract limit.</p>` : ""}</div><div>${invitationPanel || managementPanel}</div></div>`;
}

function renderView(view: ViewName): void {
  const copy = viewCopy[view];
  const content = document.querySelector<HTMLElement>(".content")!;
  const previousView = document.querySelector<HTMLElement>(".nav-item.active")?.dataset.view;
  content.classList.toggle("overview-layout", view === "overview");
  document.querySelector("#eyebrow")!.textContent = copy.eyebrow;
  document.querySelector("#page-title")!.textContent = copy.title;
  document.querySelector("#page-description")!.textContent = copy.description;
  document.querySelectorAll(".nav-item").forEach((node) => node.classList.toggle("active", (node as HTMLElement).dataset.view === view));
  if (previousView !== view) content.scrollTop = 0;

  if (view === "overview") {
    const active = assetDetails();
    const fiat = selectedAsset === "ipi" && active.initialized ? formatUsd(active.balance) : "No fiat valuation";
    const cardState = active.security.state === "blocked"
      ? "● CARD BLOCKED"
      : active.initialized && !account.cardConnected ? "○ SESSION ACTIVE · INSERT TO SIGN"
        : active.initialized ? "● ISOLATED KEY READY" : "○ INITIALIZATION REQUIRED";
    viewRoot.innerHTML = `
      ${signingCardNotice()}
      <div class="portfolio-card">
        <div class="portfolio-top"><div><span class="kicker">SELECTED NETWORK BALANCE</span><div class="portfolio-value" id="wallet-balance">${escapeHtml(active.formattedBalance)}</div><div class="portfolio-fiat" id="wallet-balance-usd">${escapeHtml(fiat)}</div><small>${selectedAsset === "ipi" ? "Declared testnet rate: 1 IPI = $2.00 USD" : "No fiat price is declared for this asset in IPI Wallet"}</small></div><label class="asset-picker">Asset<select id="asset-select" aria-label="Select asset"><option value="ipi" ${selectedAsset === "ipi" ? "selected" : ""}>IPI · Testnet</option><option value="ethereum" ${selectedAsset === "ethereum" ? "selected" : ""}>ETH · Mainnet</option><option value="bitcoin" ${selectedAsset === "bitcoin" ? "selected" : ""}>BTC · Mainnet</option></select></label></div>
        <div class="portfolio-account"><div><span>${active.symbol} wallet address</span><code id="wallet-address">${escapeHtml(active.address ?? (active.installed ? "Profile not initialized" : "IPI Card or applet unavailable"))}</code></div><span class="card-state ${active.initialized && active.security.state !== "blocked" && account.cardConnected ? "online" : ""}">${cardState}</span></div>
        <div class="portfolio-actions"><button class="button primary" id="portfolio-receive" ${active.initialized ? "" : "disabled"}>Receive ${active.symbol}</button><button class="button secondary" id="portfolio-send" ${selectedAsset === "ipi" && active.initialized ? "" : "disabled"}>${selectedAsset === "ipi" ? "Send from card" : "Send coming next"}</button>${active.initialized ? "" : `<button class="button secondary" id="initialize-selected" ${account.cardConnected && allWalletAppletsInstalled() ? "" : "disabled"}>Initialize entire card</button>`}</div>
      </div>
      <div class="portfolio-grid"><div class="asset-list">${assetRow("ipi")}${assetRow("ethereum")}${assetRow("bitcoin")}</div><article class="network-summary"><div><span>Network</span><strong>${escapeHtml(active.network)}</strong></div><div><span>Chain</span><strong>${escapeHtml(active.chain)}</strong></div><div><span>Custody</span><strong>Dedicated card applet</strong></div>${selectedAsset === "ipi" ? `<div><span>Latest block</span><strong id="cosmos-height">—</strong></div><div><span>EVM head</span><strong id="evm-height">—</strong></div><button data-external="explorer">Open explorer ↗</button>` : ""}</article></div>`;
  } else if (view === "send-card") {
    viewRoot.innerHTML = !account.exists ? notice("Connect your IPI Card first", "An initialized card is required to send IPI.") : `${signingCardNotice()}${notice("Personal card transfer", "Funds leave only this card's public IPI address. The returned signature is verified locally before broadcast.")}<form class="form-panel" id="send-form" data-send-source="card"><label>Recipient address<input id="send-recipient" autocomplete="off" spellcheck="false" placeholder="ipi1…" required></label><label>Amount<div class="amount-input"><input id="send-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" required><span>IPI</span></div></label><div class="review" id="send-review"><span>Network</span><strong>ipi-testnet-1</strong><span>Maximum fixed fee</span><strong>0.0003 IPI</strong><span>Source</span><strong>${escapeHtml(account.address)}</strong></div><div class="dialog-error" id="send-error"></div><button class="button primary wide" id="send-submit" ${account.cardConnected ? "" : "disabled"}>${account.cardConnected ? "Review card transfer" : "Insert or tap card to continue"}</button></form>`;
  } else if (view === "receive-card") {
    const active = assetDetails();
    const mainnetWarning = selectedAsset === "ipi" ? "" : notice("Real network — real funds", "Receive is enabled, but mainnet Send remains disabled until transaction-intent validation and recovery are ready.");
    viewRoot.innerHTML = `${assetSwitcher(selectedAsset)}${mainnetWarning}${active.initialized && active.address ? `<div class="receive-card"><span class="tag">${active.symbol} · ${active.network.toUpperCase()}</span><div class="qr-frame"><canvas id="receive-qr" role="img" aria-label="QR code containing this ${active.symbol} address"></canvas></div><code id="receive-address"></code><p>Scan to receive ${active.symbol}. The QR contains only this card's address.</p><p>${escapeHtml(`Its private key was generated and remains inside the dedicated ${active.symbol} applet.`)}</p><button class="button secondary" id="copy-address">Copy address</button></div>` : `${notice(`${active.symbol} address is not ready`, allWalletAppletsInstalled() ? "Initialize the complete card with one shared password for IPI, ETH and BTC." : "Insert a fully provisioned IPI Card.")}<div class="empty-state"><div class="qr-placeholder">▦</div><h3>No ${active.symbol} address yet</h3><p>Initialization is one-way and private keys cannot be exported.</p><button class="button primary" id="receive-create" ${allWalletAppletsInstalled() ? "" : "disabled"}>Initialize entire card</button></div>`}`;
  } else if (view === "vault") {
    viewRoot.innerHTML = `${signingCardNotice()}${renderVaultView()}`;
  } else if (view === "send-vault") {
    if (!account.exists) viewRoot.innerHTML = notice("Insert an initialized IPI Card", "The vault requires an active card session.");
    else if (!account.unlocked) viewRoot.innerHTML = vaultUnlockNotice();
    else if (!vaultStatus?.currentMember) viewRoot.innerHTML = `<div class="form-panel settings">${notice("No active vault membership", "Open a vault or accept its invitation before sending shared funds.")}<button class="button primary" type="button" data-go-cards>Open Cards</button></div>`;
    else if (!vaultConfiguration.relayAvailable) viewRoot.innerHTML = notice("Payment Relay code is not deployed", "The server must store the audited payment-relay Wasm and configure IPI_PAYMENT_RELAY_CODE_ID before this feature can be used.");
    else if (vaultRelayAddresses.length !== vaultConfiguration.relayCount) viewRoot.innerHTML = `${notice("Create the vault payment route once", "Five immutable contracts will be bound to this vault. The active card pays the one-time instantiate fee.")}<div class="section-grid"><form class="form-panel" id="relay-setup-form"><h3>Create five payment relays</h3><p>Every payment uses all five relays in a fresh random order. Their route remains public and auditable on-chain.</p><div class="review" id="vault-review"><span>Relay code</span><strong>${escapeHtml(vaultConfiguration.relayCodeId)}</strong><span>Administrator</span><strong>None · immutable</strong><span>Maximum setup fee</span><strong>0.0075 IPI · active card</strong></div><div class="dialog-error" id="vault-error"></div><button class="button primary wide" id="relay-setup-submit" ${account.cardConnected ? "" : "disabled"}>Review relay setup</button></form><form class="form-panel" id="relay-connect-form"><h3>Connect an existing relay set</h3><p>Paste the five addresses if this vault was configured on another computer. Every contract and slot is verified on-chain.</p><label>Five relay addresses<textarea id="relay-connect-addresses" rows="7" spellcheck="false" placeholder="ipi1…&#10;ipi1…&#10;ipi1…&#10;ipi1…&#10;ipi1…" required></textarea></label><div class="dialog-error" id="relay-connect-error"></div><button class="button secondary wide">Verify relay set</button></form></div>`;
    else viewRoot.innerHTML = `${signingCardNotice()}${notice("Transparent receiver-balance privacy", "The recipient sees the final relay as the immediate bank sender. The vault, card controller and all five randomized hops remain publicly traceable in the same atomic transaction.")}<form class="form-panel" id="send-form" data-send-source="vault"><label>Recipient address<input id="send-recipient" autocomplete="off" spellcheck="false" placeholder="ipi1…" required></label><label>Amount<div class="amount-input"><input id="send-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" required><span>IPI</span></div></label><div class="review" id="send-review"><span>Source</span><strong>Unlocked vault · ${escapeHtml(formatIpi(vaultStatus.balance))}</strong><span>Route</span><strong>5 / 5 relays · new random order</strong><span>Maximum fixed fee</span><strong>0.0075 IPI</strong></div><div class="dialog-error" id="send-error"></div><button class="button primary wide" id="send-submit" ${account.cardConnected ? "" : "disabled"}>${account.cardConnected ? "Review vault payment" : "Insert or tap card to continue"}</button></form>`;
  } else if (view === "receive-vault") {
    if (!account.exists) viewRoot.innerHTML = notice("Insert an initialized IPI Card", "The vault requires an active card session.");
    else if (!account.unlocked) viewRoot.innerHTML = vaultUnlockNotice();
    else if (!vaultStatus?.currentMember) viewRoot.innerHTML = notice("No active vault membership", "Open a vault or accept its invitation first.");
    else viewRoot.innerHTML = `<div class="receive-card"><span class="tag">IPI · SHARED VAULT</span><div class="qr-frame"><canvas id="receive-qr" role="img" aria-label="QR code containing the shared vault address"></canvas></div><code id="receive-address"></code><p>Send IPI directly to the shared vault account shown above.</p><p>Every active equal card can authorize spending from this account.</p><button class="button secondary" id="copy-address">Copy vault address</button></div>`;
  } else if (view === "cards") {
    viewRoot.innerHTML = `${signingCardNotice()}${renderCardsView()}`;
  } else if (view === "checkout") {
    viewRoot.innerHTML = `${notice("Checkout V2 integration is staged", "The desktop app will validate terminal signatures, live product ownership and exact amounts before enabling approval.")}<div class="checkout-flow"><div class="flow-step ready"><i>1</i><div><strong>Scan terminal request</strong><span>IPIQR3 / multipart QR</span></div></div><div class="flow-step"><i>2</i><div><strong>Verify operation</strong><span>Merchant, products and terminal key</span></div></div><div class="flow-step"><i>3</i><div><strong>Approve in Wallet</strong><span>Human-readable authorization</span></div></div><div class="flow-step"><i>4</i><div><strong>Receive proof bundle</strong><span>Receipt, warranty and ownership</span></div></div></div>`;
  } else if (view === "hardware") {
    const readyKeys = [account.exists, chainAccounts.ethereum.initialized, chainAccounts.bitcoin.initialized].filter(Boolean).length;
    const ipiAppletState = account.exists && !account.cardConnected ? "Session active · card removed" : account.exists ? "Initialized · Testnet" : account.installed ? "Factory state · Testnet" : account.cardConnected ? "Not installed" : "Unavailable";
    const allInstalled = account.installed && chainAccounts.ethereum.installed && chainAccounts.bitcoin.installed;
    viewRoot.innerHTML = `${signingCardNotice()}<div class="hardware-card"><div class="physical-card"><img src="./ipi-logo.svg" alt="IPI"><strong>I PROVE IT</strong><small>CARD-ONLY WALLET</small></div><div><span class="tag">${account.exists && !account.cardConnected ? "VIEW-ONLY SESSION" : "MAINNET RECEIVE PREVIEW"}</span><h2>One card.<br>Three isolated keys.</h2><p>IPI, Ethereum and Bitcoin use independent secp256k1 key pairs in separate Java Card packages. The in-memory session retains only public addresses and profile metadata; private keys never leave the card.</p><dl><div><dt>Reader</dt><dd>${escapeHtml(account.cardConnected ? account.reader : "Card removed")}</dd></div><div><dt>IPI applet</dt><dd>${ipiAppletState}</dd></div><div><dt>Ethereum applet</dt><dd>${chainAccounts.ethereum.initialized ? "Initialized · Mainnet" : chainAccounts.ethereum.installed ? "Factory state · Mainnet" : "Unavailable"}</dd></div><div><dt>Bitcoin applet</dt><dd>${chainAccounts.bitcoin.initialized ? "Initialized · Mainnet" : chainAccounts.bitcoin.installed ? "Factory state · Mainnet" : "Unavailable"}</dd></div><div><dt>Keys ready</dt><dd>${readyKeys} / 3</dd></div><div><dt>Signing</dt><dd>${account.cardConnected ? "Physical card available" : "Blocked until card returns"}</dd></div><div><dt>Private keys</dt><dd>Card only · no backup</dd></div></dl>${allInstalled && readyKeys < 3 && account.cardConnected ? `<button class="button primary wide" id="initialize-all">Initialize card · create ${3 - readyKeys} remaining ${3 - readyKeys === 1 ? "key" : "keys"}</button>` : ""}</div></div>`;
  } else if (view === "security") {
    const profiles = (["ipi", "ethereum", "bitcoin"] as AssetSelector[]).map((asset) => assetDetails(asset));
    const initializedProfiles = profiles.filter((profile) => profile.initialized);
    const blockedProfiles = initializedProfiles.filter((profile) => profile.security.state === "blocked");
    const statusRows = initializedProfiles.map((profile) => `<div class="setting-row"><div><strong>${profile.symbol}</strong><span>Card Password: ${escapeHtml(profile.security.triesRemaining)} / ${escapeHtml(profile.security.retryLimit)} · Recovery: ${escapeHtml(profile.security.recoveryTriesRemaining)} / ${escapeHtml(profile.security.recoveryRetryLimit)}</span></div><span class="tag ${profile.security.state === "blocked" ? "" : "green"}">${escapeHtml(profile.security.state.toUpperCase())}</span></div>`).join("");
    if (!account.cardConnected) viewRoot.innerHTML = notice(account.exists ? "Insert the session IPI Card" : "Insert an IPI Card", account.exists ? "This view-only session cannot unlock or sign until the same physical card is connected again." : "Security controls become available when a supported card is connected.");
    else if (initializedProfiles.length === 0) viewRoot.innerHTML = `${notice("Card profiles are in factory state", "Initialize the card before using password controls.")}<button class="button primary" id="initialize-all">Initialize card</button>`;
    else if (blockedProfiles.length > 0 && initializedProfiles.some((profile) => !profile.security.recoverySupported || profile.security.recoveryTriesRemaining === 0)) viewRoot.innerHTML = `${notice("CARD BLOCKED", "Recovery is unavailable on at least one profile because it uses the older protocol or its 10 Recovery Password attempts were exhausted. Private keys cannot be exported.")}<div class="form-panel settings">${statusRows}</div>`;
    else if (blockedProfiles.length > 0) viewRoot.innerHTML = `${notice("CARD BLOCKED", "Normal unlock is disabled. Enter the Recovery Password to set one new Card Password for every initialized profile; all addresses and private keys remain unchanged.")}<div class="form-panel settings">${statusRows}<h3>Recover card access</h3><form id="recovery-form"><label>Recovery Password<input id="recovery-password" type="password" minlength="10" maxlength="128" autocomplete="current-password" required autofocus></label><label>New Card Password<input id="recovery-new-password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label>Repeat new Card Password<input id="recovery-new-password-repeat" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><div class="dialog-error" id="security-error"></div><button class="button primary wide">Recover all card profiles</button></form></div>`;
    else viewRoot.innerHTML = `${securityToast ? `<div class="security-toast" role="status"><span>✓</span>${escapeHtml(securityToast)}</div>` : ""}<div class="form-panel settings"><h3>Card access</h3>${statusRows}${account.exists ? account.unlocked ? `<button class="button secondary" id="security-lock">Lock IPI now</button>` : `<form id="unlock-form"><label>Card Password<input id="unlock-password" type="password" minlength="10" maxlength="128" autocomplete="current-password" required></label><button class="button secondary wide">Unlock IPI for one signing attempt</button></form>` : ""}<h3>Change the Card Password</h3><p>One password protects every initialized IPI, ETH and BTC profile.</p><form id="change-password-form"><label>Current Card Password<input id="current-password" type="password" minlength="10" maxlength="128" autocomplete="current-password" required></label><label>New Card Password<input id="new-password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label>Repeat new Card Password<input id="new-password-repeat" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><div class="dialog-error" id="security-error"></div><button class="button primary wide">Change password on all profiles</button></form></div>`;
  } else {
    viewRoot.innerHTML = `<div class="form-panel settings"><h3>Networks</h3><div class="setting-row"><div><strong>IPI Public Testnet</strong><span>Cosmos ipi-testnet-1 · EVM 42424</span></div><span class="tag green">ACTIVE</span></div><div class="setting-row"><div><strong>Ethereum Mainnet</strong><span>Chain ID 1 · Receive only</span></div><span class="tag green">ACTIVE</span></div><div class="setting-row"><div><strong>Bitcoin Mainnet</strong><span>Native SegWit · Receive only</span></div><span class="tag green">ACTIVE</span></div><h3>Security mode</h3><div class="setting-row"><div><strong>Fail closed</strong><span>Unavailable or unverified operations cannot be signed.</span></div><span class="toggle on"></span></div><h3>Developer</h3><div class="setting-row"><div><strong>Endpoint details</strong><span>Mainnet RPC endpoints can be replaced through environment configuration.</span></div><button class="text-button" data-external="webWallet">View public config ↗</button></div></div>`;
  }
  bindDynamicActions();
  const active = assetDetails();
  const activeReceiveAddress = view === "receive-vault" && account.unlocked && vaultStatus?.currentMember
    ? vaultStatus.contractAddress
    : active.address;
  const receiveAddress = document.querySelector("#receive-address");
  if (receiveAddress) receiveAddress.textContent = activeReceiveAddress;
  if (activeReceiveAddress) renderReceiveQr(activeReceiveAddress);
  const copyAddressButton = document.querySelector<HTMLButtonElement>("#copy-address");
  copyAddressButton?.addEventListener("click", () => activeReceiveAddress && void copyAddressWithFeedback(activeReceiveAddress, copyAddressButton));
  document.querySelector<HTMLSelectElement>("#asset-select")?.addEventListener("change", (event) => {
    selectedAsset = (event.currentTarget as HTMLSelectElement).value as AssetSelector;
    renderView("overview");
  });
  document.querySelectorAll<HTMLElement>("[data-asset]").forEach((button) => button.addEventListener("click", () => {
    selectedAsset = button.dataset.asset as AssetSelector;
    renderView("overview");
  }));
  document.querySelectorAll<HTMLElement>("[data-asset-switch]").forEach((button) => button.addEventListener("click", () => {
    const asset = button.dataset.assetSwitch as AssetSelector;
    selectedAsset = asset;
    renderView(view);
  }));
  document.querySelector<HTMLFormElement>("#send-form")?.addEventListener("submit", (event) => void handleSend(event));
  document.querySelector<HTMLFormElement>("#vault-create-form")?.addEventListener("submit", (event) => void handleVaultCreate(event));
  document.querySelector<HTMLFormElement>("#vault-connect-form")?.addEventListener("submit", (event) => void handleVaultConnect(event));
  document.querySelector<HTMLFormElement>("#vault-invite-form")?.addEventListener("submit", (event) => void handleVaultInvite(event));
  document.querySelector("#vault-accept")?.addEventListener("click", () => void handleVaultAccept());
  document.querySelectorAll<HTMLButtonElement>("[data-vault-cancel]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.vaultCancel;
    if (target) void handleVaultMembershipAction("cancel", target, button);
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-vault-remove]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.vaultRemove;
    if (target) void handleVaultMembershipAction("remove", target, button);
  }));
  document.querySelectorAll("#vault-disconnect").forEach((button) => button.addEventListener("click", forgetVault));
  const copyVaultButton = document.querySelector<HTMLButtonElement>("#vault-copy-address");
  copyVaultButton?.addEventListener("click", () => vaultStatus && void copyAddressWithFeedback(vaultStatus.contractAddress, copyVaultButton));
  document.querySelector<HTMLFormElement>("#relay-setup-form")?.addEventListener("submit", (event) => void handleRelaySetup(event));
  document.querySelector<HTMLFormElement>("#relay-connect-form")?.addEventListener("submit", (event) => void handleRelayConnect(event));
  document.querySelectorAll("[data-go-security]").forEach((button) => button.addEventListener("click", () => renderView("security")));
  document.querySelectorAll("[data-go-vault]").forEach((button) => button.addEventListener("click", () => renderView("vault")));
  document.querySelectorAll("[data-go-cards]").forEach((button) => button.addEventListener("click", () => renderView("cards")));
  document.querySelector<HTMLFormElement>("#unlock-form")?.addEventListener("submit", (event) => void handleUnlock(event));
  document.querySelector<HTMLFormElement>("#change-password-form")?.addEventListener("submit", (event) => void handlePasswordChange(event));
  document.querySelector<HTMLFormElement>("#recovery-form")?.addEventListener("submit", (event) => void handleRecovery(event));
  document.querySelector("#security-lock")?.addEventListener("click", () => void lockSecurityTarget());
}

async function handleUnlock(event: SubmitEvent): Promise<void> {
  event.preventDefault(); const error = document.querySelector("#security-error")!;
  const input = document.querySelector<HTMLInputElement>("#unlock-password")!;
  const password = input.value; input.value = "";
  try {
    const target = assetDetails("ipi");
    const credential = await deriveCardCredential(password, target.profile, target.credentialSalt);
    account = await window.ipiDesktop.unlockCard(credential, target.credentialSalt);
    renderView("security");
  }
  catch (cause) { error.textContent = friendlyError(cause, "Error: Unlock failed"); await refreshAccount(); }
}

async function handlePasswordChange(event: SubmitEvent): Promise<void> {
  event.preventDefault(); const error = document.querySelector("#security-error")!;
  const currentInput = document.querySelector<HTMLInputElement>("#current-password")!;
  const nextInput = document.querySelector<HTMLInputElement>("#new-password")!;
  const repeatInput = document.querySelector<HTMLInputElement>("#new-password-repeat")!;
  const current = currentInput.value; const next = nextInput.value; const repeated = repeatInput.value;
  currentInput.value = ""; nextInput.value = ""; repeatInput.value = "";
  if (next !== repeated) { error.textContent = "New passwords do not match"; return; }
  try {
    const assets = (["ipi", "ethereum", "bitcoin"] as AssetSelector[]).filter((asset) => assetDetails(asset).initialized);
    const credentials = await Promise.all(assets.map(async (asset) => {
      const target = assetDetails(asset);
      const [oldCredential, nextCredential] = await Promise.all([
        deriveCardCredential(current, target.profile, target.credentialSalt),
        deriveCardCredential(next, target.profile, target.credentialSalt),
      ]);
      return { asset, target, oldCredential, nextCredential };
    }));
    // Validate the current password on every profile before changing any of them.
    for (const item of credentials) {
      if (item.asset === "ipi") account = await window.ipiDesktop.unlockCard(item.oldCredential, item.target.credentialSalt);
      else chainAccounts[item.asset] = await window.ipiDesktop.unlockChain(item.asset, item.oldCredential, item.target.credentialSalt);
    }
    for (const item of credentials) {
      if (item.asset === "ipi") account = await window.ipiDesktop.changeCardPassword(item.oldCredential, item.nextCredential, item.target.credentialSalt);
      else chainAccounts[item.asset] = await window.ipiDesktop.changeChainPassword(item.asset, item.oldCredential, item.nextCredential, item.target.credentialSalt);
    }
    securityToast = "Card Password changed on every initialized profile";
    window.clearTimeout(securityToastTimer);
    securityToastTimer = window.setTimeout(() => { securityToast = ""; document.querySelector(".security-toast")?.remove(); }, 3_200);
    renderView("security");
  }
  catch (cause) { error.textContent = friendlyError(cause, "Error: Password change failed"); await refreshAccount(); }
}

async function handleRecovery(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const error = document.querySelector("#security-error")!;
  const recoveryInput = document.querySelector<HTMLInputElement>("#recovery-password")!;
  const nextInput = document.querySelector<HTMLInputElement>("#recovery-new-password")!;
  const repeatInput = document.querySelector<HTMLInputElement>("#recovery-new-password-repeat")!;
  const recoveryPassword = recoveryInput.value;
  const nextPassword = nextInput.value;
  const repeated = repeatInput.value;
  recoveryInput.value = ""; nextInput.value = ""; repeatInput.value = "";
  if (nextPassword !== repeated) { error.textContent = "New passwords do not match"; return; }
  if (recoveryPassword.normalize("NFKC") === nextPassword.normalize("NFKC")) { error.textContent = "Recovery Password and Card Password must be different"; return; }
  try {
    const assets = (["ipi", "ethereum", "bitcoin"] as AssetSelector[])
      .filter((asset) => assetDetails(asset).initialized)
      .sort((left, right) => Number(assetDetails(right).security.state === "blocked") - Number(assetDetails(left).security.state === "blocked"));
    for (const asset of assets) {
      const target = assetDetails(asset);
      const [recoveryCredential, nextCredential] = await Promise.all([
        deriveCardCredential(recoveryPassword, target.profile, target.credentialSalt, "recovery"),
        deriveCardCredential(nextPassword, target.profile, target.credentialSalt),
      ]);
      if (asset === "ipi") account = await window.ipiDesktop.recoverCardPassword(recoveryCredential, nextCredential, target.credentialSalt);
      else chainAccounts[asset] = await window.ipiDesktop.recoverChainPassword(asset, recoveryCredential, nextCredential, target.credentialSalt);
    }
    securityToast = "Card access recovered; all addresses and private keys are unchanged";
    await refreshAccount();
    renderView("security");
  } catch (cause) {
    const message = friendlyError(cause, "Error: Recovery failed");
    await refreshAccount();
    renderView("security");
    const currentError = document.querySelector("#security-error");
    if (currentError) currentError.textContent = message;
  }
}

async function lockSecurityTarget(): Promise<void> {
  account = await window.ipiDesktop.lockCard();
  renderView("security");
}

async function handleSend(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const source = (event.currentTarget as HTMLFormElement).dataset.sendSource;
  const recipientInput = document.querySelector<HTMLInputElement>("#send-recipient")!;
  const amountInput = document.querySelector<HTMLInputElement>("#send-amount")!;
  const submit = document.querySelector<HTMLButtonElement>("#send-submit")!;
  const error = document.querySelector("#send-error")!;
  const reviewBox = document.querySelector("#send-review")!;
  const recipient = recipientInput.value.trim();
  const amount = amountInput.value.trim();
  let executionRequested = false;
  submit.disabled = true;
  error.textContent = "";
  try {
    if (source === "vault") {
      if (!vaultAddress || !vaultStatus?.currentMember) throw new Error("This card is not active in a shared vault");
      if (vaultRelayAddresses.length !== vaultConfiguration.relayCount) throw new Error("This vault does not have a verified payment relay set");
      const fingerprint = `relay-transfer|${vaultAddress}|${vaultRelayAddresses.join(",")}|${recipient}|${amount}`;
      const reviewToExecute = usableVaultReview(fingerprint);
      if (!reviewToExecute) {
        const review = await window.ipiDesktop.reviewVaultRelayTransfer(vaultAddress, vaultRelayAddresses, recipient, amount);
        pendingVaultAction = { fingerprint, review };
        reviewBox.innerHTML = `<span>Vault</span><strong>${escapeHtml(review.contractAddress)}</strong><span>Recipient</span><strong>${escapeHtml(review.target)}</strong><span>Amount</span><strong>${escapeHtml(formatIpi(review.amount!))}</strong><span>Network fee</span><strong>${escapeHtml(formatIpi(review.fee))} · ${review.feeGranter ? "vault" : "card controller"}</strong><span>Payment ID</span><strong>${escapeHtml(review.paymentId)}</strong><span>Exact route</span><strong>${(review.route ?? []).map((relay, index) => `${index + 1}. ${escapeHtml(relay)}`).join("<br>")}</strong>`;
        submit.textContent = "Sign this exact vault payment";
      } else {
        submit.textContent = "Broadcasting and waiting…";
        executionRequested = true;
        const result = await window.ipiDesktop.executeVaultAction(reviewToExecute.reviewId);
        pendingVaultAction = null;
        await refreshVault(true);
        viewRoot.innerHTML = `<div class="form-panel settings">${notice("Vault payment confirmed", "All five randomized relay hops were verified in the public transaction events.")}<div class="review"><span>Block</span><strong>${escapeHtml(result.height)}</strong><span>Transaction</span><strong>${escapeHtml(result.txHash)}</strong><span>Payment ID</span><strong>${escapeHtml(result.paymentId)}</strong></div><button class="button primary" type="button" data-go-security>Unlock for another vault payment</button></div>`;
        bindDynamicActions();
      }
    } else if (!pendingSend || pendingSend.recipient !== recipient || pendingSend.amount !== amount) {
      const review = await window.ipiDesktop.reviewSend(recipient, amount);
      pendingSend = { recipient, amount, review };
      reviewBox.innerHTML = `<span>Recipient</span><strong>${escapeHtml(review.recipient)}</strong><span>Amount</span><strong>${escapeHtml(formatIpi(review.amount))}</strong><span>Network fee</span><strong>${escapeHtml(formatIpi(review.fee))}</strong><span>Balance before</span><strong>${escapeHtml(formatIpi(review.balance))}</strong>`;
      submit.textContent = "Sign with card and broadcast";
    } else {
      submit.textContent = "Broadcasting and waiting…";
      executionRequested = true;
      const result = await window.ipiDesktop.executeSend(pendingSend.review.reviewId);
      balanceAmount = result.balanceAfter;
      pendingSend = null;
      reviewBox.innerHTML = `<span>Status</span><strong>Confirmed at block ${escapeHtml(result.height)}</strong><span>Transaction</span><strong>${escapeHtml(result.txHash)}</strong><span>Balance after</span><strong>${escapeHtml(formatIpi(result.balanceAfter))}</strong><span>Signature</span><strong>Locally verified · low-S</strong>`;
      submit.textContent = "Prepare another transfer";
      recipientInput.value = "";
      amountInput.value = "";
    }
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "Transfer failed";
  } finally {
    if (executionRequested && account.security.supported) account = { ...account, unlocked: false };
    submit.disabled = false;
  }
}

function showVaultReview(review: VaultReview): void {
  const box = document.querySelector("#vault-review");
  if (!box) return;
  const action = review.action === "create" ? "Create immutable vault"
    : review.action === "invite" ? "Invite full-access card"
      : review.action === "accept" ? "Accept full-access invitation"
        : review.action === "cancel" ? "Cancel pending invitation"
          : review.action === "remove" ? "Remove full-access card"
            : review.action === "setup-relays" ? "Create five immutable payment relays"
              : review.action === "relay-transfer" ? "Transfer through five public relays"
                : "Transfer shared funds";
  box.innerHTML = `<span>Operation</span><strong>${escapeHtml(action)}</strong><span>Signer card</span><strong>${escapeHtml(review.signer)}</strong>${review.target ? `<span>Target card</span><strong>${escapeHtml(review.target)}</strong>` : ""}<span>Network fee</span><strong>${escapeHtml(formatIpi(review.fee))} · ${review.feeGranter ? "shared wallet" : "card controller"}</strong><span>Expires</span><strong>${escapeHtml(new Date(review.expiresAt).toLocaleTimeString())}</strong>`;
}

function usableVaultReview(fingerprint: string): VaultReview | null {
  if (!pendingVaultAction || pendingVaultAction.fingerprint !== fingerprint) return null;
  const expiresAt = Date.parse(pendingVaultAction.review.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - Date.now() <= REVIEW_EXECUTION_MARGIN_MS) {
    pendingVaultAction = null;
    return null;
  }
  return pendingVaultAction.review;
}

async function copyAddressWithFeedback(address: string, button: HTMLButtonElement): Promise<void> {
  const originalLabel = button.textContent ?? "Copy address";
  try {
    await window.ipiDesktop.copyAddress(address);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = originalLabel;
  }, 1_500);
}

async function finishVaultAction(review: VaultReview): Promise<VaultResult> {
  const result = await window.ipiDesktop.executeVaultAction(review.reviewId);
  vaultAddress = result.contractAddress;
  localStorage.setItem("ipi-card-vault-address", result.contractAddress);
  if (result.relayAddresses) {
    vaultRelayAddresses = result.relayAddresses;
    localStorage.setItem(relayStorageKey(result.contractAddress), JSON.stringify(result.relayAddresses));
  }
  pendingVaultAction = null;
  await refreshVault(true);
  return result;
}

async function handleRelaySetup(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!vaultAddress) return;
  const submit = document.querySelector<HTMLButtonElement>("#relay-setup-submit")!;
  const error = document.querySelector("#vault-error")!;
  const fingerprint = `setup-relays|${vaultAddress}|${vaultConfiguration.relayCodeId}`;
  submit.disabled = true;
  error.textContent = "";
  try {
    const reviewToExecute = usableVaultReview(fingerprint);
    if (!reviewToExecute) {
      const review = await window.ipiDesktop.reviewVaultRelaySetup(vaultAddress);
      pendingVaultAction = { fingerprint, review };
      showVaultReview(review);
      submit.textContent = "Sign and create five relays";
    } else {
      submit.textContent = "Creating and verifying five relays…";
      const result = await finishVaultAction(reviewToExecute);
      if (result.relayAddresses?.length !== vaultConfiguration.relayCount) throw new Error("The confirmed relay set is incomplete");
      account = { ...account, unlocked: false };
      renderView("send-vault");
    }
  } catch (cause) {
    error.textContent = friendlyError(cause, "Error: Relay setup failed");
  } finally {
    submit.disabled = false;
  }
}

async function handleRelayConnect(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!vaultAddress) return;
  const input = document.querySelector<HTMLTextAreaElement>("#relay-connect-addresses")!;
  const error = document.querySelector("#relay-connect-error")!;
  error.textContent = "";
  try {
    const addresses = input.value.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
    const result = await window.ipiDesktop.getVaultRelayPoolStatus(vaultAddress, addresses);
    vaultRelayAddresses = result.relays;
    localStorage.setItem(relayStorageKey(result.vault), JSON.stringify(result.relays));
    renderView("send-vault");
  } catch (cause) {
    error.textContent = friendlyError(cause, "Error: Relay verification failed");
  }
}

async function handleVaultCreate(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const submit = document.querySelector<HTMLButtonElement>("#vault-create-submit")!;
  const error = document.querySelector("#vault-error")!;
  const fingerprint = "create";
  submit.disabled = true;
  error.textContent = "";
  try {
    const reviewToExecute = usableVaultReview(fingerprint);
    if (!reviewToExecute) {
      const review = await window.ipiDesktop.reviewVaultCreate();
      pendingVaultAction = { fingerprint, review };
      showVaultReview(review);
      submit.textContent = "Sign and create shared account";
    } else {
      submit.textContent = "Creating and confirming…";
      await finishVaultAction(reviewToExecute);
      account = { ...account, unlocked: false };
      renderView("cards");
    }
  } catch (cause) {
    error.textContent = friendlyError(cause, "Error: Vault creation failed");
  } finally {
    submit.disabled = false;
  }
}

async function handleVaultConnect(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const input = document.querySelector<HTMLInputElement>("#vault-connect-address")!;
  const error = document.querySelector("#vault-connect-error")!;
  const candidate = input.value.trim();
  error.textContent = "";
  try {
    const status = await window.ipiDesktop.getVaultStatus(candidate);
    if (!status.currentMember && !status.currentInvitation) {
      throw new Error("This card is neither active nor invited in that vault");
    }
    vaultAddress = status.contractAddress;
    vaultStatus = status;
    vaultError = "";
    lastVaultRefresh = Date.now();
    localStorage.setItem("ipi-card-vault-address", status.contractAddress);
    vaultRelayAddresses = loadRelayAddresses(status.contractAddress);
    renderView("cards");
  } catch (cause) {
    error.textContent = friendlyError(cause, "Error: Vault verification failed");
  }
}

async function handleVaultInvite(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!vaultAddress) return;
  const addressInput = document.querySelector<HTMLInputElement>("#vault-invite-address")!;
  const submit = document.querySelector<HTMLButtonElement>("#vault-invite-submit")!;
  const error = document.querySelector("#vault-error")!;
  const invitedAddress = addressInput.value.trim();
  const fingerprint = `invite|${vaultAddress}|${invitedAddress}`;
  submit.disabled = true;
  error.textContent = "";
  try {
    const reviewToExecute = usableVaultReview(fingerprint);
    if (!reviewToExecute) {
      const review = await window.ipiDesktop.reviewVaultInvite(vaultAddress, invitedAddress);
      pendingVaultAction = { fingerprint, review };
      showVaultReview(review);
      submit.textContent = "Sign and publish invitation";
    } else {
      submit.textContent = "Publishing and confirming…";
      await finishVaultAction(reviewToExecute);
      account = { ...account, unlocked: false };
      renderView("cards");
    }
  } catch (cause) {
    error.textContent = friendlyError(cause, "Error: Invitation failed");
  } finally {
    submit.disabled = false;
  }
}

async function handleVaultAccept(): Promise<void> {
  if (!vaultAddress) return;
  const submit = document.querySelector<HTMLButtonElement>("#vault-accept")!;
  const error = document.querySelector("#vault-error")!;
  const fingerprint = `accept|${vaultAddress}|${account.address}`;
  submit.disabled = true;
  error.textContent = "";
  try {
    const reviewToExecute = usableVaultReview(fingerprint);
    if (!reviewToExecute) {
      const review = await window.ipiDesktop.reviewVaultAccept(vaultAddress);
      pendingVaultAction = { fingerprint, review };
      showVaultReview(review);
      submit.textContent = "Sign and join shared account";
    } else {
      submit.textContent = "Joining and confirming…";
      await finishVaultAction(reviewToExecute);
      account = { ...account, unlocked: false };
      renderView("cards");
    }
  } catch (cause) {
    error.textContent = friendlyError(cause, "Error: Invitation acceptance failed");
  } finally {
    submit.disabled = false;
  }
}

async function handleVaultMembershipAction(action: "cancel" | "remove", target: string, submit: HTMLButtonElement): Promise<void> {
  if (!vaultAddress) return;
  const error = document.querySelector("#vault-error")!;
  const fingerprint = `${action}|${vaultAddress}|${target}`;
  submit.disabled = true;
  error.textContent = "";
  try {
    const reviewToExecute = usableVaultReview(fingerprint);
    if (!reviewToExecute) {
      const review = action === "cancel"
        ? await window.ipiDesktop.reviewVaultCancel(vaultAddress, target)
        : await window.ipiDesktop.reviewVaultRemove(vaultAddress, target);
      pendingVaultAction = { fingerprint, review };
      showVaultReview(review);
      submit.textContent = action === "cancel" ? "Confirm cancellation" : "Confirm removal";
    } else {
      submit.textContent = action === "cancel" ? "Cancelling…" : "Removing…";
      await finishVaultAction(reviewToExecute);
      account = { ...account, unlocked: false };
      renderView("cards");
    }
  } catch (cause) {
    error.textContent = friendlyError(cause, action === "cancel" ? "Error: Invitation cancellation failed" : "Error: Card removal failed");
  } finally {
    submit.disabled = false;
  }
}

function forgetVault(): void {
  vaultAddress = null;
  vaultStatus = null;
  vaultError = "";
  pendingVaultAction = null;
  vaultRelayAddresses = [];
  localStorage.removeItem("ipi-card-vault-address");
  renderView("vault");
}

async function openExternal(key: keyof typeof links): Promise<void> {
  await window.ipiDesktop.openExternal(links[key]);
}

function bindDynamicActions(): void {
  document.querySelectorAll<HTMLElement>("[data-external]").forEach((button) => {
    button.onclick = () => void openExternal(button.dataset.external as keyof typeof links);
  });
  ["initialize-selected", "receive-create", "initialize-all"].forEach((id) => document.querySelector(`#${id}`)?.addEventListener("click", openAccountDialog));
  document.querySelector("#portfolio-receive")?.addEventListener("click", () => renderView("receive-card"));
  document.querySelector("#portfolio-send")?.addEventListener("click", () => renderView("send-card"));
}

function openAccountDialog(): void {
  const productionProfiles = (["ipi", "ethereum", "bitcoin"] as AssetSelector[]).map((asset) => assetDetails(asset));
  if (!account.cardConnected || productionProfiles.some((profile) => !profile.installed)) return;
  if (productionProfiles.every((profile) => profile.initialized)) {
    void refreshAccount().then(() => renderView("hardware"));
    return;
  }
  const remaining = productionProfiles.filter((profile) => !profile.initialized).length;
  document.querySelector("#dialog-error")!.textContent = "";
  document.querySelector("#dialog-title")!.textContent = "Initialize IPI Card";
  document.querySelector("#dialog-copy")!.textContent = `One Card Password and one Recovery Password will protect IPI, ETH and BTC. The card generates ${remaining} remaining isolated key ${remaining === 1 ? "pair" : "pairs"}; profile-domain separation prevents credential reuse between applets.`;
  document.querySelector("#dialog-submit")!.textContent = `Initialize card and create ${remaining} ${remaining === 1 ? "address" : "addresses"}`;
  document.querySelector<HTMLDialogElement>("#account-dialog")!.showModal();
}

async function refreshAccount(): Promise<void> {
  const wallet = await window.ipiDesktop.getWalletStatus();
  account = wallet.account;
  chainAccounts = wallet.chains;
  if (account.exists) {
    const cardChanged = account.address !== lastVaultCardAddress;
    if (cardChanged) vaultStatus = null;
    await Promise.all([refreshBalance(), refreshVault(cardChanged)]);
  } else {
    balanceAmount = "0";
    vaultStatus = null;
    lastVaultCardAddress = null;
  }
  await refreshChainBalances();
  const cardStatus = document.querySelector<HTMLElement>("#card-status")!;
  const ready = [account.exists, chainAccounts.ethereum.initialized, chainAccounts.bitcoin.initialized].filter(Boolean).length;
  cardStatus.textContent = account.cardConnected
    ? `● Card · ${ready}/3 keys`
    : account.exists ? "○ Session · insert card to sign" : "Connect card";
}

async function refreshVault(force = false): Promise<void> {
  if (!account.exists || !account.address || !vaultAddress || !vaultConfiguration.available) {
    vaultStatus = null;
    vaultError = "";
    lastVaultCardAddress = account.address;
    return;
  }
  if (vaultRefreshInProgress) return;
  if (!force && Date.now() - lastVaultRefresh < 15_000 && account.address === lastVaultCardAddress) return;
  vaultRefreshInProgress = true;
  try {
    vaultStatus = await window.ipiDesktop.getVaultStatus(vaultAddress);
    vaultAddress = vaultStatus.contractAddress;
    vaultError = "";
    lastVaultRefresh = Date.now();
    lastVaultCardAddress = account.address;
    if (account.unlocked) {
      const vaultBalance = document.querySelector("#vault-balance");
      if (vaultBalance) vaultBalance.textContent = formatIpi(vaultStatus.balance);
    }
  } catch (cause) {
    vaultStatus = null;
    vaultError = friendlyError(cause, "Error: Vault unavailable");
    lastVaultCardAddress = account.address;
  } finally {
    vaultRefreshInProgress = false;
  }
}

async function refreshBalance(): Promise<void> {
  if (!account.exists || !account.address || balanceRefreshInProgress) return;
  balanceRefreshInProgress = true;
  const expectedAddress = account.address;
  try {
    const balance = await window.ipiDesktop.getBalance(expectedAddress);
    if (account.address !== expectedAddress || balance.address !== expectedAddress) return;
    balanceAmount = balance.amount;
    const formatted = formatIpi(balanceAmount);
    const formattedUsd = formatUsd(balanceAmount);
    const total = selectedAsset === "ipi" ? document.querySelector("#wallet-balance") : null;
    const totalUsd = selectedAsset === "ipi" ? document.querySelector("#wallet-balance-usd") : null;
    const asset = document.querySelector("#asset-balance-ipi");
    if (total) total.textContent = formatted;
    if (totalUsd) totalUsd.textContent = formattedUsd;
    if (asset) asset.textContent = formatted;
  } catch {
    // Keep the last confirmed balance when the endpoint is temporarily unavailable.
  } finally {
    balanceRefreshInProgress = false;
  }
}

async function refreshChainBalances(): Promise<void> {
  if (chainBalanceRefreshInProgress) return;
  chainBalanceRefreshInProgress = true;
  try {
    const tasks = (["ethereum", "bitcoin"] as const).map(async (chain) => {
      const current = chainAccounts[chain];
      if (!current.initialized || !current.address) {
        chainBalances[chain] = "0";
        return;
      }
      const expectedAddress = current.address;
      const result = await window.ipiDesktop.getChainBalance(chain, expectedAddress);
      if (chainAccounts[chain].address === expectedAddress && result.address.toLowerCase() === expectedAddress.toLowerCase()) chainBalances[chain] = result.amount;
    });
    await Promise.allSettled(tasks);
    for (const chain of ["ethereum", "bitcoin"] as const) {
      const formatted = chain === "ethereum" ? formatEth(chainBalances.ethereum) : formatBtc(chainBalances.bitcoin);
      const row = document.querySelector(`#asset-balance-${chain}`);
      if (row && chainAccounts[chain].initialized) row.textContent = formatted;
      if (selectedAsset === chain) {
        const total = document.querySelector("#wallet-balance");
        if (total) total.textContent = formatted;
      }
    }
  } finally {
    chainBalanceRefreshInProgress = false;
  }
}

async function recoverCardConnection(): Promise<void> {
  if (cardRecoveryInProgress || account.cardConnected || document.visibilityState !== "visible") return;
  cardRecoveryInProgress = true;
  try {
    await refreshAccount();
    if (!account.cardConnected) return;
    const activeView = document.querySelector<HTMLButtonElement>(".nav-item.active")?.dataset.view as ViewName || "overview";
    renderView(activeView);
  } finally {
    cardRecoveryInProgress = false;
  }
}

async function submitAccountForm(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const submit = document.querySelector<HTMLButtonElement>("#dialog-submit")!;
  const error = document.querySelector("#dialog-error")!;
  submit.disabled = true;
  error.textContent = "";
  try {
    const passwordInput = document.querySelector<HTMLInputElement>("#initialize-password")!;
    const repeatInput = document.querySelector<HTMLInputElement>("#initialize-password-repeat")!;
    const recoveryInput = document.querySelector<HTMLInputElement>("#initialize-recovery-password")!;
    const recoveryRepeatInput = document.querySelector<HTMLInputElement>("#initialize-recovery-password-repeat")!;
    const password = passwordInput.value; const repeated = repeatInput.value;
    const recoveryPassword = recoveryInput.value; const repeatedRecovery = recoveryRepeatInput.value;
    passwordInput.value = ""; repeatInput.value = ""; recoveryInput.value = ""; recoveryRepeatInput.value = "";
    if (password !== repeated) throw new Error("Passwords do not match");
    if (recoveryPassword !== repeatedRecovery) throw new Error("Recovery Passwords do not match");
    if (password.normalize("NFKC") === recoveryPassword.normalize("NFKC")) throw new Error("Recovery Password and Card Password must be different");
    for (const asset of ["ipi", "ethereum", "bitcoin"] as AssetSelector[]) {
      const target = assetDetails(asset);
      const [credential, recoveryCredential] = await Promise.all([
        deriveCardCredential(password, target.profile, target.credentialSalt),
        deriveCardCredential(recoveryPassword, target.profile, target.credentialSalt, "recovery"),
      ]);
      if (target.initialized) {
        // Resuming a partial initialization proves both shared passwords on
        // the already initialized profiles before continuing.
        if (asset === "ipi") account = await window.ipiDesktop.recoverCardPassword(recoveryCredential, credential, target.credentialSalt);
        else chainAccounts[asset] = await window.ipiDesktop.recoverChainPassword(asset, recoveryCredential, credential, target.credentialSalt);
      } else if (asset === "ipi") account = await window.ipiDesktop.initializeCard(credential, recoveryCredential, target.credentialSalt);
      else chainAccounts[asset] = await window.ipiDesktop.initializeChain(asset, credential, recoveryCredential, target.credentialSalt);
    }
    selectedAsset = "ipi";
    document.querySelector<HTMLDialogElement>("#account-dialog")!.close();
    document.querySelector<HTMLFormElement>("#account-form")!.reset();
    await refreshAccount();
    renderView(document.querySelector<HTMLButtonElement>(".nav-item.active")?.dataset.view as ViewName || "overview");
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "Wallet operation failed";
  } finally { submit.disabled = false; }
}

async function refreshNetwork(): Promise<void> {
  const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
  refresh.classList.add("spinning");
  try {
    const status = await window.ipiDesktop.getNetworkStatus();
    const online = status.cosmos.online && status.evm.online;
    document.querySelector("#network-label")!.textContent = online ? "Network operational" : "Network degraded";
    document.querySelector("#network-dot")!.classList.toggle("offline", !online);
    const cosmos = document.querySelector("#cosmos-height");
    const evm = document.querySelector("#evm-height");
    if (cosmos) cosmos.textContent = formatHeight(status.cosmos.height);
    if (evm) evm.textContent = formatHeight(status.evm.height);
  } catch {
    document.querySelector("#network-label")!.textContent = "Network unavailable";
    document.querySelector("#network-dot")!.classList.add("offline");
  } finally {
    refresh.classList.remove("spinning");
  }
}

document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((button) => button.addEventListener("click", () => renderView(button.dataset.view as ViewName)));
document.querySelector("#refresh")!.addEventListener("click", () => void refreshNetwork());
document.querySelector("#logout")!.addEventListener("click", () => void window.ipiDesktop.logout());
document.querySelector("#dialog-close")!.addEventListener("click", () => {
  document.querySelector<HTMLDialogElement>("#account-dialog")!.close();
  document.querySelector<HTMLFormElement>("#account-form")!.reset();
  document.querySelector("#dialog-error")!.textContent = "";
});
document.querySelector("#theme-toggle")!.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("ipi-wallet-theme", theme);
});
document.querySelector<HTMLFormElement>("#account-form")!.addEventListener("submit", (event) => void submitAccountForm(event as SubmitEvent));
let cardRefreshTimer: number | undefined;
window.ipiDesktop.onCardChanged(() => {
  window.clearTimeout(cardRefreshTimer);
  cardRefreshTimer = window.setTimeout(async () => {
    await refreshAccount();
    const activeView = document.querySelector<HTMLButtonElement>(".nav-item.active")?.dataset.view as ViewName || "overview";
    renderView(activeView);
    void refreshNetwork();
  }, 500);
});
window.ipiDesktop.onSecurityLocked(() => {
  account = { ...account, unlocked: false };
  pendingSend = null;
  pendingVaultAction = null;
  const activeView = document.querySelector<HTMLButtonElement>(".nav-item.active")?.dataset.view as ViewName || "overview";
  if (["vault", "send-vault", "receive-vault", "cards"].includes(activeView)) renderView(activeView);
});
vaultConfiguration = await window.ipiDesktop.getVaultConfiguration();
await refreshAccount();
renderView("overview");
void refreshNetwork();
window.setInterval(() => {
  if (document.visibilityState === "visible") {
    void refreshBalance();
    void refreshVault();
    void refreshChainBalances();
  }
}, BALANCE_REFRESH_INTERVAL_MS);
window.setInterval(() => {
  void recoverCardConnection();
}, CARD_RECOVERY_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (account.cardConnected) {
    void refreshBalance();
    void refreshVault(true);
    void refreshChainBalances();
  }
  else void recoverCardConnection();
});
