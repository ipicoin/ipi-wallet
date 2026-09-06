import { app, BrowserWindow, clipboard, ipcMain, powerMonitor, session, shell, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bech32 } from "@scure/base";
import { Any } from "cosmjs-types/google/protobuf/any";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { MsgExecuteContract, MsgInstantiateContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { AuthInfo, Fee, ModeInfo, SignDoc, SignerInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { CARD_VAULT, CHAIN, ENDPOINTS, PAYMENT_RELAY } from "./config.js";
import { fetchJson } from "./network.js";
import { assertUnsignedDecimal, CredentialSession, displayAmountToUint128, validateCredential, validateReviewId, withCredentialHex } from "./security.js";
import { PublicWalletSession, type SessionChainStatus } from "./wallet-session.js";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const isDevelopment = !app.isPackaged && process.env.NODE_ENV !== "production";
const appIconPath = app.isPackaged
  ? join(process.resourcesPath, "ipi-wallet.png")
  : join(currentDir, "../icon.png");
const pythonExecutable = app.isPackaged ? "/usr/bin/python3" : (process.env.IPI_WALLET_PYTHON ?? "python3");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
app.enableSandbox();
if (!hasSingleInstanceLock) app.quit();

const ALLOWED_EXTERNAL_HOSTS = new Set([
  "wallet.ipi.io",
  "scan.ipi.io",
  "faucet-testnet.ipi.io",
  "status-testnet.ipi.io",
]);

let sendInProgress = false;
let cardWatcher: ChildProcessWithoutNullStreams | null = null;
let cardWatcherRestartTimer: NodeJS.Timeout | null = null;
let applicationQuitting = false;
let activeCardReader: string | null = null;
let activeCardHasIpiApplet = false;
let unlockSession: CredentialSession | null = null;
let cardBridgeQueue: Promise<void> = Promise.resolve();
let cardOperationActive = false;
let ignoreCardEventsUntil = 0;
let removalConfirmationTimer: NodeJS.Timeout | null = null;
let mainWindow: BrowserWindow | null = null;
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const cardBridgePath = app.isPackaged
  ? join(process.resourcesPath, "card_bridge.py")
  : join(currentDir, "card_bridge.py");
const REVIEW_TTL_MS = 300_000;

type CardSecurity = { supported: boolean; state: string; triesRemaining: number | null; retryLimit: number | null; recoverySupported: boolean; recoveryTriesRemaining: number | null; recoveryRetryLimit: number | null };
type CardBridgeStatus = { connected: boolean; initialized: boolean; publicKey: string | null; reader: string; profile: string; credentialSalt: string | null; authCounter: number | null; security: CardSecurity };
type ChainSelector = "ethereum" | "bitcoin";
type CardBridgeAction = "presence" | "status" | "initialize" | "verify" | "change-password" | "recover" | "sign" | "status-profile" | "initialize-profile" | "verify-profile" | "change-password-profile" | "recover-profile" | "sign-profile";
type CardPresence = { connected: true; reader: string; atr: string };
type SendReview = { reviewId: string; expiresAt: string; sender: string; recipient: string; amount: string; fee: string; balance: string; chainId: string };
type PendingReview = { review: SendReview; signDoc: SignDoc; publicKey: string; credentialSalt: string | null; expiresAt: number };
type VaultMember = { address: string };
type VaultInvitation = { address: string };
type VaultStatus = {
  contractAddress: string;
  codeId: string;
  balance: string;
  memberCount: number;
  currentMember: VaultMember | null;
  currentInvitation: VaultInvitation | null;
  members: VaultMember[];
  invitations: VaultInvitation[];
};
type PaymentRelay = { address: string; vault: string; slot: number; codeId: string };
type VaultAction = "create" | "invite" | "accept" | "cancel" | "remove" | "setup-relays" | "relay-transfer";
type VaultReview = {
  reviewId: string;
  expiresAt: string;
  action: VaultAction;
  signer: string;
  contractAddress: string | null;
  target: string | null;
  amount: string | null;
  fee: string;
  feeGranter: string | null;
  controllerBalance: string;
  vaultBalance: string | null;
  chainId: string;
  codeId: string;
  relayCodeId?: string;
  route?: string[];
  paymentId?: string;
};
type PendingVaultReview = { review: VaultReview; signDoc: SignDoc; publicKey: string; credentialSalt: string | null; expiresAt: number };
const pendingReviews = new Map<string, PendingReview>();
const pendingVaultReviews = new Map<string, PendingVaultReview>();
const publicWalletSession = new PublicWalletSession();

function hardenedPythonEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of ["PYTHONHOME", "PYTHONPATH", "PYTHONINSPECT", "PYTHONSTARTUP", "PYTHONUSERBASE"]) {
    delete environment[name];
  }
  environment.PYTHONDONTWRITEBYTECODE = "1";
  environment.PYTHONNOUSERSITE = "1";
  environment.PYTHONSAFEPATH = "1";
  return environment;
}

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function validateChainSelector(raw: unknown): ChainSelector {
  if (raw !== "ethereum" && raw !== "bitcoin") throw new Error("Unsupported card profile");
  return raw;
}

function clearUnlockCredential(): void {
  unlockSession?.destroy();
  unlockSession = null;
}

function clearAllUnlocks(): void {
  const wasUnlocked = unlockSession !== null;
  clearUnlockCredential();
  pendingReviews.clear();
  pendingVaultReviews.clear();
  if (wasUnlocked && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("security:locked");
  }
}

function replaceUnlock(credential: Buffer, publicKey: string): void {
  unlockSession?.destroy();
  unlockSession = new CredentialSession(credential, publicKey);
}

function addressFromPublicKey(publicKey: Uint8Array): string {
  const point = secp256k1.Point.fromBytes(publicKey);
  const uncompressed = point.toBytes(false);
  const addressBytes = keccak_256(uncompressed.slice(1)).slice(-20);
  return bech32.encode("ipi", bech32.toWords(addressBytes));
}

function ethereumAddressFromPublicKey(publicKey: Uint8Array): string {
  const point = secp256k1.Point.fromBytes(publicKey);
  const lower = bytesToHex(keccak_256(point.toBytes(false).slice(1)).slice(-20));
  const checksum = bytesToHex(keccak_256(Buffer.from(lower, "ascii")));
  return `0x${Array.from(lower, (character, index) => (
    Number.parseInt(checksum[index], 16) >= 8 ? character.toUpperCase() : character
  )).join("")}`;
}

function bitcoinMainnetAddressFromPublicKey(publicKey: Uint8Array): string {
  const compressed = secp256k1.Point.fromBytes(publicKey).toBytes(true);
  const witnessProgram = ripemd160(sha256(compressed));
  return bech32.encode("bc", [0, ...bech32.toWords(witnessProgram)], 90);
}

async function runCardBridge(action: CardBridgeAction, ...arguments_: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [cardBridgePath, action], {
      env: hardenedPythonEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const maxBuffer = 64 * 1024;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(result);
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > maxBuffer) {
        child.kill();
        finish(new Error("Card bridge output exceeded the safety limit"));
      }
      return next;
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Card communication timed out"));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (finished) return;
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Card bridge exited with code ${code}`));
        return;
      }
      try { finish(undefined, JSON.parse(stdout)); }
      catch { finish(new Error("Card bridge returned malformed JSON")); }
    });
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(JSON.stringify(arguments_));
  });
}

function cardBridge(action: CardBridgeAction, ...arguments_: string[]): Promise<any> {
  const execute = async () => {
    cardOperationActive = true;
    try {
      return await runCardBridge(action, ...arguments_);
    } finally {
      cardOperationActive = false;
      // ACR1281U reports a brief remove/insert pair when a T=1 session is
      // closed. It is a reader reset, not a physical card removal.
      ignoreCardEventsUntil = Date.now() + 2_000;
    }
  };
  const operation = cardBridgeQueue.then(
    execute,
    execute,
  );
  cardBridgeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function accountSummary() {
  try {
    const card = await cardBridge("status-profile", "ipi") as CardBridgeStatus;
    activeCardReader = card.reader;
    activeCardHasIpiApplet = true;
    if (!card.initialized || !card.publicKey) {
      if (publicWalletSession.clear()) clearAllUnlocks();
      return { exists: false, installed: true, cardConnected: true, address: null, publicKey: null, reader: card.reader, profile: card.profile, credentialSalt: card.credentialSalt, security: card.security, unlocked: false };
    }
    const publicKey = secp256k1.Point.fromBytes(Buffer.from(card.publicKey, "hex")).toBytes(true);
    const keyHex = bytesToHex(publicKey);
    const connected = { exists: true, installed: true, cardConnected: true, address: addressFromPublicKey(publicKey), publicKey: keyHex, reader: card.reader, profile: card.profile, credentialSalt: card.credentialSalt, security: card.security, unlocked: unlockSession?.matches(keyHex) ?? false };
    if (publicWalletSession.rememberAccount(connected)) clearAllUnlocks();
    return connected;
  } catch {
    clearUnlockCredential();
    try {
      const presence = await cardBridge("presence") as CardPresence;
      activeCardReader = presence.reader;
      activeCardHasIpiApplet = false;
      if (publicWalletSession.clear()) clearAllUnlocks();
      return { exists: false, installed: false, cardConnected: true, address: null, publicKey: null, reader: presence.reader, profile: "unprovisioned", credentialSalt: null, security: { supported: false, state: "applet-missing", triesRemaining: null, retryLimit: null, recoverySupported: false, recoveryTriesRemaining: null, recoveryRetryLimit: null }, unlocked: false };
    } catch {
      activeCardReader = null;
      activeCardHasIpiApplet = false;
      return publicWalletSession.account() ?? { exists: false, installed: false, cardConnected: false, address: null, publicKey: null, reader: "", profile: "none", credentialSalt: null, security: { supported: false, state: "disconnected", triesRemaining: null, retryLimit: null, recoverySupported: false, recoveryTriesRemaining: null, recoveryRetryLimit: null }, unlocked: false };
    }
  }
}

function unavailableChainSummary(chain: ChainSelector): SessionChainStatus {
  return {
    chain, installed: false, initialized: false, address: null, publicKey: null,
    reader: "", profile: "none", credentialSalt: null, authCounter: null,
    security: { supported: false, state: "unavailable", triesRemaining: null, retryLimit: null, recoverySupported: false, recoveryTriesRemaining: null, recoveryRetryLimit: null }, unlocked: false,
  };
}

async function chainAccountSummary(chain: ChainSelector, cardConnected = activeCardReader !== null) {
  if (!cardConnected) return publicWalletSession.chain(chain) ?? unavailableChainSummary(chain);
  try {
    const card = await cardBridge("status-profile", chain) as CardBridgeStatus;
    activeCardReader = card.reader;
    const publicKey = card.publicKey ? secp256k1.Point.fromBytes(Buffer.from(card.publicKey, "hex")).toBytes(true) : null;
    const address = publicKey
      ? chain === "ethereum" ? ethereumAddressFromPublicKey(publicKey) : bitcoinMainnetAddressFromPublicKey(publicKey)
      : null;
    const keyHex = publicKey ? bytesToHex(publicKey) : null;
    const connected = {
      chain, installed: true, initialized: card.initialized, address,
      publicKey: keyHex,
      reader: card.reader, profile: card.profile, credentialSalt: card.credentialSalt,
      authCounter: card.authCounter, security: card.security,
      unlocked: false,
    };
    publicWalletSession.rememberChain(connected);
    return connected;
  } catch {
    publicWalletSession.forgetChain(chain);
    return unavailableChainSummary(chain);
  }
}

async function walletSummary() {
  const account = await accountSummary();
  const ethereum = await chainAccountSummary("ethereum", account.cardConnected);
  const bitcoin = await chainAccountSummary("bitcoin", account.cardConnected);
  return { account, chains: { ethereum, bitcoin } };
}

function validateExpectedSalt(raw: unknown, card: CardBridgeStatus): string {
  const expected = raw === null ? "" : raw;
  if (typeof expected !== "string" || (expected !== "" && !/^[0-9a-f]{32}$/i.test(expected))) throw new Error("Expected card salt is malformed");
  if ((card.credentialSalt ?? "") !== expected.toLowerCase()) throw new Error("The card profile changed while deriving the password credential");
  return expected.toLowerCase();
}

function compactLowSSignature(derHex: string): Uint8Array {
  const signature = secp256k1.Signature.fromBytes(Buffer.from(derHex, "hex"), "der");
  const normalized = signature.hasHighS()
    ? new secp256k1.Signature(signature.r, SECP256K1_ORDER - signature.s)
    : signature;
  return normalized.toBytes("compact");
}

function validateIpiAddress(raw: unknown, label = "Recipient"): string {
  if (typeof raw !== "string") throw new Error(`${label} address is required`);
  try {
    const decoded = bech32.decode(raw as `${string}1${string}`, 90);
    const bytes = bech32.fromWords(decoded.words);
    if (decoded.prefix !== CHAIN.bech32Prefix || (bytes.length !== 20 && bytes.length !== 32)) throw new Error("invalid");
    return raw.toLowerCase();
  } catch { throw new Error(`${label} must be a valid IPI address`); }
}

function validateCardAddress(raw: unknown, label = "Card"): string {
  const address = validateIpiAddress(raw, label);
  const decoded = bech32.decode(address as `${string}1${string}`, 90);
  if (bech32.fromWords(decoded.words).length !== 20) throw new Error(`${label} must be a card-derived IPI address`);
  return address;
}

function parseBaseAccount(payload: any): { accountNumber: bigint; sequence: bigint } {
  let account = payload?.account;
  while (account && !("account_number" in account) && !("accountNumber" in account)) {
    account = account.base_account ?? account.baseAccount ?? account.base_vesting_account ?? account.baseVestingAccount;
  }
  const accountNumber = account?.account_number ?? account?.accountNumber;
  const sequence = account?.sequence;
  if (!/^\d+$/.test(String(accountNumber)) || !/^\d+$/.test(String(sequence))) throw new Error("Malformed account response");
  return { accountNumber: BigInt(accountNumber), sequence: BigInt(sequence) };
}

async function queryBalance(address: string): Promise<string> {
  const url = `${ENDPOINTS.rest}/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}/by_denom?denom=${CHAIN.baseDenom}`;
  const payload = await fetchJson(url) as Record<string, any>;
  const amount = String(payload?.balance?.amount ?? "0");
  if (!/^[0-9]+$/.test(amount)) throw new Error("Malformed balance response");
  return amount;
}

function validateEthereumAddress(raw: unknown): string {
  if (typeof raw !== "string" || !/^0x[0-9a-f]{40}$/i.test(raw)) throw new Error("Invalid Ethereum address");
  return raw;
}

function validateBitcoinMainnetAddress(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Invalid Bitcoin Mainnet address");
  try {
    const decoded = bech32.decode(raw as `${string}1${string}`, 90);
    const program = bech32.fromWords(decoded.words.slice(1));
    if (decoded.prefix !== "bc" || decoded.words[0] !== 0 || program.length !== 20) throw new Error("invalid");
    return raw.toLowerCase();
  } catch {
    throw new Error("Invalid native SegWit Bitcoin Mainnet address");
  }
}

async function ethereumRpc(method: string, params: unknown[]): Promise<unknown> {
  const payload = await fetchJson(ENDPOINTS.ethereumMainnet, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }) as Record<string, unknown>;
  if (payload.error) throw new Error(`Ethereum Mainnet RPC rejected ${method}`);
  return payload.result;
}

async function queryEthereumBalance(address: string): Promise<string> {
  const [chainId, balance] = await Promise.all([
    ethereumRpc("eth_chainId", []),
    ethereumRpc("eth_getBalance", [address, "latest"]),
  ]);
  if (chainId !== "0x1") throw new Error("Ethereum endpoint is not Mainnet (chain 1)");
  if (typeof balance !== "string" || !/^0x[0-9a-f]+$/i.test(balance)) throw new Error("Malformed Ethereum balance response");
  return BigInt(balance).toString();
}

async function queryBitcoinBalance(address: string): Promise<string> {
  const payload = await fetchJson(`${ENDPOINTS.bitcoinMainnet}/address/${encodeURIComponent(address)}`) as Record<string, any>;
  const confirmed = BigInt(assertUnsignedDecimal(payload?.chain_stats?.funded_txo_sum ?? "0", "Bitcoin funded balance"))
    - BigInt(assertUnsignedDecimal(payload?.chain_stats?.spent_txo_sum ?? "0", "Bitcoin spent balance"));
  const pending = BigInt(assertUnsignedDecimal(payload?.mempool_stats?.funded_txo_sum ?? "0", "Bitcoin mempool funded balance"))
    - BigInt(assertUnsignedDecimal(payload?.mempool_stats?.spent_txo_sum ?? "0", "Bitcoin mempool spent balance"));
  if (confirmed < 0n || confirmed + pending < 0n) throw new Error("Malformed Bitcoin balance response");
  return (confirmed + pending).toString();
}

async function queryAccount(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  try {
    const payload = await fetchJson(`${ENDPOINTS.rest}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`);
    return parseBaseAccount(payload);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "HTTP 404") {
      throw new Error("This card address is not active on IPI Testnet yet. Fund its IPI Receive address with test IPI, wait for confirmation and try again");
    }
    throw cause;
  }
}

function encodeEthPubkey(key: Uint8Array): Uint8Array {
  if (key.length !== 33) throw new Error("Unexpected public-key length");
  return Uint8Array.from([0x0a, key.length, ...key]);
}

function makeMessagesSignDoc(messages: Any[], publicKey: Uint8Array, accountNumber: bigint, sequence: bigint, fee: string, gasLimit: bigint, feeGranter = "") {
  if (messages.length === 0 || messages.length > 16) throw new Error("Transaction message count is unsupported");
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages, memo: "" })).finish();
  const authInfoBytes = AuthInfo.encode(AuthInfo.fromPartial({
    signerInfos: [SignerInfo.fromPartial({
      publicKey: Any.fromPartial({ typeUrl: CHAIN.publicKeyTypeUrl, value: encodeEthPubkey(publicKey) }),
      modeInfo: ModeInfo.fromPartial({ single: { mode: SignMode.SIGN_MODE_DIRECT } }), sequence,
    })],
    fee: Fee.fromPartial({ amount: [{ denom: CHAIN.baseDenom, amount: fee }], gasLimit, granter: feeGranter }),
  })).finish();
  return SignDoc.fromPartial({ bodyBytes, authInfoBytes, chainId: CHAIN.cosmosChainId, accountNumber });
}

function makeMessageSignDoc(message: Any, publicKey: Uint8Array, accountNumber: bigint, sequence: bigint, fee: string, gasLimit: bigint, feeGranter = "") {
  return makeMessagesSignDoc([message], publicKey, accountNumber, sequence, fee, gasLimit, feeGranter);
}

function makeSignDoc(fromAddress: string, toAddress: string, amount: string, publicKey: Uint8Array, accountNumber: bigint, sequence: bigint) {
  const message = MsgSend.fromPartial({ fromAddress, toAddress, amount: [{ denom: CHAIN.baseDenom, amount }] });
  return makeMessageSignDoc(
    Any.fromPartial({ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: MsgSend.encode(message).finish() }),
    publicKey,
    accountNumber,
    sequence,
    CHAIN.feeBase,
    CHAIN.gasLimit,
  );
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function makeVaultExecuteSignDoc(
  sender: string,
  contract: string,
  executeMessage: unknown,
  publicKey: Uint8Array,
  accountNumber: bigint,
  sequence: bigint,
  feeGranter: string | null,
) {
  const message = MsgExecuteContract.fromPartial({
    sender,
    contract,
    msg: jsonBytes(executeMessage),
    funds: [],
  });
  return makeMessageSignDoc(
    Any.fromPartial({ typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", value: MsgExecuteContract.encode(message).finish() }),
    publicKey,
    accountNumber,
    sequence,
    CARD_VAULT.executeFeeBase,
    CARD_VAULT.executeGasLimit,
    feeGranter ?? "",
  );
}

function vaultExecuteAny(sender: string, contract: string, executeMessage: unknown, funds: Array<{ denom: string; amount: string }> = []): Any {
  const message = MsgExecuteContract.fromPartial({
    sender,
    contract,
    msg: jsonBytes(executeMessage),
    funds,
  });
  return Any.fromPartial({
    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
    value: MsgExecuteContract.encode(message).finish(),
  });
}

function makeRelaySetupSignDoc(
  sender: string,
  vault: string,
  publicKey: Uint8Array,
  accountNumber: bigint,
  sequence: bigint,
) {
  if (!PAYMENT_RELAY.codeId) throw new Error("IPI Payment Relay code ID is not configured");
  const messages = Array.from({ length: PAYMENT_RELAY.count }, (_, slot) => {
    const message = MsgInstantiateContract.fromPartial({
      sender,
      admin: "",
      codeId: BigInt(PAYMENT_RELAY.codeId!),
      label: `IPI Payment Relay ${slot + 1}/${PAYMENT_RELAY.count}`,
      msg: jsonBytes({ vault, slot }),
      funds: [],
    });
    return Any.fromPartial({
      typeUrl: "/cosmwasm.wasm.v1.MsgInstantiateContract",
      value: MsgInstantiateContract.encode(message).finish(),
    });
  });
  return makeMessagesSignDoc(
    messages,
    publicKey,
    accountNumber,
    sequence,
    PAYMENT_RELAY.setupFeeBase,
    PAYMENT_RELAY.setupGasLimit,
  );
}

function makeRelayPaymentSignDoc(
  sender: string,
  vault: string,
  route: string[],
  recipient: string,
  amount: string,
  paymentId: string,
  publicKey: Uint8Array,
  accountNumber: bigint,
  sequence: bigint,
  feeGranter: string | null,
) {
  if (route.length !== PAYMENT_RELAY.count) throw new Error("Exactly five payment relays are required");
  const messages = [
    vaultExecuteAny(sender, vault, { transfer: { recipient: sender, amount } }),
    vaultExecuteAny(
      sender,
      route[0],
      {
        forward: {
          controller: sender,
          route: route.slice(1),
          recipient,
          payment_id: paymentId,
        },
      },
      [{ denom: CHAIN.baseDenom, amount }],
    ),
  ];
  return makeMessagesSignDoc(
    messages,
    publicKey,
    accountNumber,
    sequence,
    PAYMENT_RELAY.paymentFeeBase,
    PAYMENT_RELAY.paymentGasLimit,
    feeGranter ?? "",
  );
}

function makeVaultInstantiateSignDoc(
  sender: string,
  publicKey: Uint8Array,
  accountNumber: bigint,
  sequence: bigint,
) {
  if (!CARD_VAULT.codeId) throw new Error("IPI Card Vault code ID is not configured");
  const message = MsgInstantiateContract.fromPartial({
    sender,
    admin: "",
    codeId: BigInt(CARD_VAULT.codeId),
    label: "IPI Card Vault",
    msg: jsonBytes({}),
    funds: [],
  });
  return makeMessageSignDoc(
    Any.fromPartial({ typeUrl: "/cosmwasm.wasm.v1.MsgInstantiateContract", value: MsgInstantiateContract.encode(message).finish() }),
    publicKey,
    accountNumber,
    sequence,
    CARD_VAULT.instantiateFeeBase,
    CARD_VAULT.instantiateGasLimit,
  );
}

function decodeSmartData(payload: unknown): Record<string, any> {
  const data = (payload as Record<string, unknown>)?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, any>;
  if (typeof data !== "string") throw new Error("Vault query returned malformed data");
  try {
    const decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid");
    return decoded;
  } catch {
    throw new Error("Vault query returned malformed data");
  }
}

async function queryVaultSmart(contractAddress: string, message: unknown): Promise<Record<string, any>> {
  const queryData = Buffer.from(JSON.stringify(message), "utf8").toString("base64");
  const payload = await fetchJson(`${ENDPOINTS.rest}/cosmwasm/wasm/v1/contract/${encodeURIComponent(contractAddress)}/smart/${encodeURIComponent(queryData)}`);
  return decodeSmartData(payload);
}

async function verifyPaymentRelay(rawAddress: unknown, expectedVault?: string): Promise<PaymentRelay> {
  if (!PAYMENT_RELAY.codeId) throw new Error("IPI Payment Relay code ID is not configured");
  const address = validateIpiAddress(rawAddress, "Payment relay");
  const payload = await fetchJson(`${ENDPOINTS.rest}/cosmwasm/wasm/v1/contract/${encodeURIComponent(address)}`) as Record<string, any>;
  const responseAddress = String(payload?.address ?? address).toLowerCase();
  const info = payload?.contract_info ?? payload?.contractInfo;
  const codeId = String(info?.code_id ?? info?.codeId ?? "");
  const admin = info?.admin;
  if (responseAddress !== address || codeId !== PAYMENT_RELAY.codeId) {
    throw new Error("Address is not an approved IPI Payment Relay contract");
  }
  if (admin !== undefined && admin !== null && admin !== "") {
    throw new Error("Payment relay contract is upgradeable by an external administrator");
  }
  const config = await queryVaultSmart(address, { config: {} });
  const vault = validateIpiAddress(config?.vault, "Relay vault");
  const slot = Number(config?.slot);
  const relayCount = Number(config?.relay_count);
  if (config?.denom !== CHAIN.baseDenom
    || !Number.isSafeInteger(slot)
    || slot < 0
    || slot >= PAYMENT_RELAY.count
    || relayCount !== PAYMENT_RELAY.count) {
    throw new Error("Payment relay configuration is malformed");
  }
  if (expectedVault && vault !== expectedVault) throw new Error("Payment relay belongs to a different vault");
  return { address, vault, slot, codeId };
}

async function validatePaymentRelayPool(rawRelays: unknown, rawVault: unknown): Promise<PaymentRelay[]> {
  if (!Array.isArray(rawRelays) || rawRelays.length !== PAYMENT_RELAY.count) {
    throw new Error(`Exactly ${PAYMENT_RELAY.count} payment relays are required`);
  }
  const vault = validateIpiAddress(rawVault, "Vault");
  const addresses = rawRelays.map((address) => validateIpiAddress(address, "Payment relay"));
  if (new Set(addresses).size !== PAYMENT_RELAY.count) throw new Error("Payment relay addresses must be unique");
  const relays = await Promise.all(addresses.map((address) => verifyPaymentRelay(address, vault)));
  const slots = relays.map((relay) => relay.slot).sort((left, right) => left - right);
  if (slots.some((slot, index) => slot !== index)) throw new Error("Payment relay slots must cover 0 through 4 exactly once");
  return relays;
}

function shuffledRelayAddresses(relays: PaymentRelay[]): string[] {
  const route = relays.map((relay) => relay.address);
  for (let index = route.length - 1; index > 0; index -= 1) {
    const selected = randomInt(index + 1);
    [route[index], route[selected]] = [route[selected], route[index]];
  }
  return route;
}

async function verifyVaultContract(contractAddress: string): Promise<string> {
  if (!CARD_VAULT.codeId) throw new Error("IPI Card Vault code ID is not configured");
  const payload = await fetchJson(`${ENDPOINTS.rest}/cosmwasm/wasm/v1/contract/${encodeURIComponent(contractAddress)}`) as Record<string, any>;
  const responseAddress = String(payload?.address ?? contractAddress).toLowerCase();
  const info = payload?.contract_info ?? payload?.contractInfo;
  const codeId = String(info?.code_id ?? info?.codeId ?? "");
  const admin = info?.admin;
  if (responseAddress !== contractAddress || codeId !== CARD_VAULT.codeId) {
    throw new Error("Address is not an approved IPI Card Vault contract");
  }
  if (admin !== undefined && admin !== null && admin !== "") {
    throw new Error("Vault contract is upgradeable by an external administrator");
  }
  return codeId;
}

function normalizeVaultMember(raw: any): VaultMember {
  return { address: validateCardAddress(raw?.address, "Member") };
}

function normalizeVaultInvitation(raw: any): VaultInvitation {
  return { address: validateCardAddress(raw?.address, "Invited card") };
}

async function queryVaultStatus(rawContractAddress: unknown, currentCardAddress: string): Promise<VaultStatus> {
  const contractAddress = validateIpiAddress(rawContractAddress, "Vault");
  const [codeId, balance, config, member, invitation, members, invitations] = await Promise.all([
    verifyVaultContract(contractAddress),
    queryBalance(contractAddress),
    queryVaultSmart(contractAddress, { config: {} }),
    queryVaultSmart(contractAddress, { member: { address: currentCardAddress } }),
    queryVaultSmart(contractAddress, { invitation: { address: currentCardAddress } }),
    queryVaultSmart(contractAddress, { members: { start_after: null, limit: 100 } }),
    queryVaultSmart(contractAddress, { invitations: { start_after: null, limit: 100 } }),
  ]);
  const memberCount = Number(config?.member_count);
  if (config?.denom !== CHAIN.baseDenom || !Number.isSafeInteger(memberCount) || memberCount < 1) {
    throw new Error("Vault configuration is malformed");
  }
  if (!Array.isArray(members?.members) || !Array.isArray(invitations?.invitations)) {
    throw new Error("Vault member list is malformed");
  }
  const currentMember = member?.member === null || member?.member === undefined
    ? null
    : normalizeVaultMember(member.member);
  const currentInvitation = invitation?.invitation === null || invitation?.invitation === undefined
    ? null
    : normalizeVaultInvitation(invitation.invitation);
  if (currentMember && currentMember.address !== currentCardAddress) throw new Error("Vault returned a different member");
  if (currentInvitation && currentInvitation.address !== currentCardAddress) throw new Error("Vault returned a different invitation");
  return {
    contractAddress,
    codeId,
    balance,
    memberCount,
    currentMember,
    currentInvitation,
    members: members.members.map(normalizeVaultMember),
    invitations: invitations.invitations.map(normalizeVaultInvitation),
  };
}

async function hasVaultFeeGrant(contractAddress: string, cardAddress: string): Promise<boolean> {
  const payload = await fetchJson(
    `${ENDPOINTS.rest}/cosmos/feegrant/v1beta1/allowances/${encodeURIComponent(cardAddress)}?pagination.limit=100`,
  ) as Record<string, any>;
  if (!Array.isArray(payload?.allowances)) throw new Error("Fee grant query returned malformed data");
  return payload.allowances.some((grant: any) => {
    const allowedMessages = grant?.allowance?.allowed_messages ?? grant?.allowance?.allowedMessages;
    return String(grant?.granter ?? "").toLowerCase() === contractAddress
      && String(grant?.grantee ?? "").toLowerCase() === cardAddress
      && grant?.allowance?.["@type"] === "/cosmos.feegrant.v1beta1.AllowedMsgAllowance"
      && Array.isArray(allowedMessages)
      && allowedMessages.includes("/cosmwasm.wasm.v1.MsgExecuteContract");
  });
}

async function broadcastAndConfirm(txBytes: Uint8Array, expectedHash: string): Promise<{ txHash: string; height: string; events: unknown[] }> {
  const payload = await fetchJson(`${ENDPOINTS.rest}/cosmos/tx/v1beta1/txs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx_bytes: Buffer.from(txBytes).toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
  }) as Record<string, any>;
  const response = payload?.tx_response;
  if (!/^[0-9A-F]{64}$/i.test(String(response?.txhash ?? ""))) throw new Error("Broadcast returned no transaction hash");
  if (Number(response.code) !== 0) throw new Error(`Broadcast rejected transaction (code ${response.code}): ${response.raw_log ?? ""}`);
  const txHash = String(response.txhash).toUpperCase();
  if (txHash !== expectedHash) throw new Error("Broadcast endpoint returned a hash that does not match the signed transaction");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const inclusion = await fetchJson(`${ENDPOINTS.rest}/cosmos/tx/v1beta1/txs/${txHash}`) as Record<string, any>;
      const included = inclusion?.tx_response;
      if (Number(included?.code) !== 0) throw new Error(`Transaction failed on-chain (code ${included?.code})`);
      if (String(included?.txhash ?? "").toUpperCase() !== expectedHash) throw new Error("Inclusion response identified a different transaction");
      if (!/^[1-9]\d*$/.test(String(included?.height ?? ""))) throw new Error("Malformed inclusion response");
      return { txHash, height: String(included.height), events: Array.isArray(included.events) ? included.events : [] };
    } catch (error: any) {
      if (!String(error?.message).includes("HTTP 404")) throw error;
    }
  }
  throw new Error(`Broadcast ${txHash} was not confirmed within 60 seconds`);
}

async function signReviewedTransaction(pending: { signDoc: SignDoc; publicKey: string; credentialSalt: string | null }): Promise<{ txHash: string; height: string; events: unknown[] }> {
  let signingCredential: Buffer | null = null;
  try {
    const account = await accountSummary();
    if (!account.exists || !account.address || !account.publicKey) throw new Error("Insert an initialized IPI Card");
    if (!account.cardConnected) throw new Error("Insert or tap the IPI Card that opened this wallet session");
    if (!account.security.supported) throw new Error("The IPI signing profile does not provide password security");
    if (account.publicKey !== pending.publicKey || account.credentialSalt !== pending.credentialSalt) {
      throw new Error("The signing card changed after transaction review");
    }
    if (!unlockSession) throw new Error("Unlock the IPI Card in Security before signing");
    signingCredential = unlockSession.consume(account.publicKey);
    unlockSession = null;
    const publicKey = Buffer.from(account.publicKey, "hex");
    const digest = keccak_256(SignDoc.encode(pending.signDoc).finish());
    const cardResult = await withCredentialHex(signingCredential, (credentialHex) => cardBridge(
      "sign-profile",
      "ipi",
      credentialHex,
      bytesToHex(digest),
      account.credentialSalt ?? "",
    )) as { signatureDer: string; publicKey: string };
    const cardPublicKey = secp256k1.Point.fromBytes(Buffer.from(cardResult.publicKey, "hex")).toBytes(true);
    if (bytesToHex(cardPublicKey) !== account.publicKey) throw new Error("The signing card changed during transaction preparation");
    const signature = compactLowSSignature(cardResult.signatureDer);
    if (!secp256k1.verify(signature, digest, publicKey, { prehash: false, lowS: true, format: "compact" })) throw new Error("Local signature verification failed");
    const txBytes = TxRaw.encode(TxRaw.fromPartial({ bodyBytes: pending.signDoc.bodyBytes, authInfoBytes: pending.signDoc.authInfoBytes, signatures: [signature] })).finish();
    const expectedHash = bytesToHex(sha256(txBytes)).toUpperCase();
    return await broadcastAndConfirm(txBytes, expectedHash);
  } finally {
    signingCredential?.fill(0);
  }
}

function eventText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  if (raw === "_contract_address" || raw === "contract_address" || raw.startsWith("ipi1")) return raw;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    if (decoded === "_contract_address" || decoded === "contract_address" || decoded.startsWith("ipi1")) return decoded;
    return raw;
  } catch {
    return raw;
  }
}

function eventAttributeText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    const bytes = Buffer.from(raw, "base64");
    const decoded = bytes.toString("utf8");
    const canonical = bytes.toString("base64").replace(/=+$/, "");
    if (canonical === raw.replace(/=+$/, "") && /^[\x20-\x7e]+$/.test(decoded)) return decoded;
  } catch {
    // REST responses may expose event attributes directly instead of base64.
  }
  return raw;
}

function instantiatedContractAddresses(events: unknown[], label: string): string[] {
  const addresses: string[] = [];
  for (const rawEvent of events) {
    const event = rawEvent as Record<string, any>;
    if (!Array.isArray(event?.attributes)) continue;
    for (const rawAttribute of event.attributes) {
      const attribute = rawAttribute as Record<string, unknown>;
      const key = eventText(attribute.key);
      if (key !== "_contract_address" && key !== "contract_address") continue;
      const address = validateIpiAddress(eventText(attribute.value), label);
      if (!addresses.includes(address)) addresses.push(address);
    }
  }
  return addresses;
}

function instantiatedContractAddress(events: unknown[]): string {
  const [address] = instantiatedContractAddresses(events, "Created vault");
  if (address) return address;
  throw new Error("The instantiate transaction did not report a vault address");
}

function verifyRelayPaymentEvents(events: unknown[], review: VaultReview): void {
  if (!review.contractAddress || !review.target || !review.amount || !review.paymentId || !review.route) {
    throw new Error("Reviewed relay payment is incomplete");
  }
  const relayEvents = events.flatMap((rawEvent) => {
    const event = rawEvent as Record<string, any>;
    if (!String(event?.type ?? "").endsWith("ipi_payment_relay") || !Array.isArray(event?.attributes)) return [];
    const attributes = new Map<string, string>();
    for (const rawAttribute of event.attributes) {
      const attribute = rawAttribute as Record<string, unknown>;
      attributes.set(eventAttributeText(attribute.key), eventAttributeText(attribute.value));
    }
    return [attributes];
  });
  if (relayEvents.length !== PAYMENT_RELAY.count) throw new Error("Confirmed transaction did not report the complete payment relay route");
  const eventsByRelay = new Map(relayEvents.map((attributes) => [attributes.get("relay"), attributes]));
  if (eventsByRelay.size !== PAYMENT_RELAY.count) throw new Error("Confirmed payment relay events contain duplicate hops");
  for (const [index, relay] of review.route.entries()) {
    const attributes = eventsByRelay.get(relay);
    if (!attributes) throw new Error("Confirmed payment relay route is missing a reviewed hop");
    const expectedNext = review.route[index + 1] ?? review.target;
    if (attributes.get("payment_id") !== review.paymentId
      || attributes.get("vault") !== review.contractAddress
      || attributes.get("controller") !== review.signer
      || attributes.get("relay") !== relay
      || attributes.get("next") !== expectedNext
      || attributes.get("recipient") !== review.target
      || attributes.get("amount") !== review.amount
      || attributes.get("denom") !== CHAIN.baseDenom) {
      throw new Error("Confirmed payment relay route differs from the reviewed operation");
    }
  }
}

function hexToNumber(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error("IPC request came from an untrusted frame");
  const sender = new URL(event.senderFrame.url);
  const trusted = isDevelopment
    ? sender.origin === "http://127.0.0.1:5173"
    : sender.protocol === "file:" && fileURLToPath(sender) === join(currentDir, "../dist/index.html");
  if (!trusted) throw new Error("IPC request came from an untrusted origin");
}

function handleIpc(channel: string, listener: (event: IpcMainInvokeEvent, ...arguments_: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...arguments_) => {
    assertTrustedSender(event);
    return listener(event, ...arguments_);
  });
}

handleIpc("network:status", async () => {
  const checkedAt = new Date().toISOString();
  const [comet, evm, evmChain] = await Promise.allSettled([
    fetchJson(`${ENDPOINTS.comet}/status`),
    fetchJson(ENDPOINTS.evm, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    }),
    fetchJson(ENDPOINTS.evm, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] }),
    }),
  ]);

  const cometPayload = comet.status === "fulfilled" ? comet.value as Record<string, any> : null;
  const evmPayload = evm.status === "fulfilled" ? evm.value as Record<string, any> : null;
  const evmChainPayload = evmChain.status === "fulfilled" ? evmChain.value as Record<string, any> : null;
  const cosmosHeight = Number.parseInt(String(cometPayload?.result?.sync_info?.latest_block_height ?? ""), 10);
  const cosmosNetwork = String(cometPayload?.result?.node_info?.network ?? "");

  return {
    checkedAt,
    cosmos: {
      online: Number.isSafeInteger(cosmosHeight) && cosmosHeight > 0 && cosmosNetwork === CHAIN.cosmosChainId,
      height: Number.isSafeInteger(cosmosHeight) ? cosmosHeight : null,
      error: comet.status === "rejected" ? "Endpoint unavailable" : null,
    },
    evm: {
      online: hexToNumber(evmPayload?.result) !== null && hexToNumber(evmChainPayload?.result) === CHAIN.evmChainId,
      height: hexToNumber(evmPayload?.result),
      error: evm.status === "rejected" || evmChain.status === "rejected"
        ? "Endpoint unavailable"
        : hexToNumber(evmChainPayload?.result) !== CHAIN.evmChainId ? "Unexpected chain identity" : null,
    },
  };
});

handleIpc("external:open", async (_event, rawUrl: unknown) => {
  if (typeof rawUrl !== "string") throw new TypeError("URL is required");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !ALLOWED_EXTERNAL_HOSTS.has(url.hostname)) {
    throw new Error("External URL is not allowed");
  }
  await shell.openExternal(url.toString());
});

handleIpc("clipboard:write-address", (_event, rawAddress: unknown) => {
  if (typeof rawAddress !== "string") throw new TypeError("Address is required");
  const address = rawAddress.toLowerCase().startsWith("ipi1")
    ? validateIpiAddress(rawAddress)
    : rawAddress.toLowerCase().startsWith("0x")
      ? validateEthereumAddress(rawAddress)
      : validateBitcoinMainnetAddress(rawAddress);
  clipboard.writeText(address);
});

handleIpc("wallet:status", async () => walletSummary());

handleIpc("wallet:logout", async () => {
  clearAllUnlocks();
  setImmediate(() => app.quit());
  return { closed: true };
});

handleIpc("chains:initialize", async (_event, rawChain: unknown, rawCredential: unknown, rawRecoveryCredential: unknown, rawExpectedSalt: unknown) => {
  const chain = validateChainSelector(rawChain);
  const card = await cardBridge("status-profile", chain) as CardBridgeStatus;
  const credential = validateCredential(rawCredential);
  const recoveryCredential = validateCredential(rawRecoveryCredential);
  const expectedSalt = validateExpectedSalt(rawExpectedSalt, card);
  try {
    await withCredentialHex(credential, (hex) => withCredentialHex(recoveryCredential, (recoveryHex) => cardBridge("initialize-profile", chain, hex, recoveryHex, expectedSalt)));
    return await chainAccountSummary(chain);
  } finally {
    credential.fill(0);
    recoveryCredential.fill(0);
  }
});

handleIpc("chains:recover", async (_event, rawChain: unknown, rawRecoveryCredential: unknown, rawNextCredential: unknown, rawExpectedSalt: unknown) => {
  const chain = validateChainSelector(rawChain);
  const card = await cardBridge("status-profile", chain) as CardBridgeStatus;
  const recoveryCredential = validateCredential(rawRecoveryCredential);
  const nextCredential = validateCredential(rawNextCredential);
  const expectedSalt = validateExpectedSalt(rawExpectedSalt, card);
  try {
    await withCredentialHex(recoveryCredential, (recoveryHex) => withCredentialHex(nextCredential, (nextHex) => cardBridge("recover-profile", chain, recoveryHex, nextHex, expectedSalt)));
    return await chainAccountSummary(chain);
  } finally {
    recoveryCredential.fill(0);
    nextCredential.fill(0);
  }
});

handleIpc("chains:unlock", async (_event, rawChain: unknown, rawCredential: unknown, rawExpectedSalt: unknown) => {
  const chain = validateChainSelector(rawChain);
  const card = await cardBridge("status-profile", chain) as CardBridgeStatus;
  const credential = validateCredential(rawCredential);
  const expectedSalt = validateExpectedSalt(rawExpectedSalt, card);
  try {
    await withCredentialHex(credential, (hex) => cardBridge("verify-profile", chain, hex, expectedSalt));
    return await chainAccountSummary(chain);
  } finally {
    credential.fill(0);
  }
});

handleIpc("chains:change-password", async (_event, rawChain: unknown, rawCurrentCredential: unknown, rawNextCredential: unknown, rawExpectedSalt: unknown) => {
  const chain = validateChainSelector(rawChain);
  const card = await cardBridge("status-profile", chain) as CardBridgeStatus;
  const currentCredential = validateCredential(rawCurrentCredential);
  const nextCredential = validateCredential(rawNextCredential);
  const expectedSalt = validateExpectedSalt(rawExpectedSalt, card);
  try {
    await withCredentialHex(currentCredential, (currentHex) => withCredentialHex(
      nextCredential,
      (nextHex) => cardBridge("change-password-profile", chain, currentHex, nextHex, expectedSalt),
    ));
    return await chainAccountSummary(chain);
  } finally {
    currentCredential.fill(0);
    nextCredential.fill(0);
  }
});

handleIpc("chains:lock", async (_event, rawChain: unknown) => {
  const chain = validateChainSelector(rawChain);
  return chainAccountSummary(chain);
});

handleIpc("chains:balance", async (_event, rawChain: unknown, rawAddress: unknown) => {
  const chain = validateChainSelector(rawChain);
  const address = chain === "ethereum"
    ? validateEthereumAddress(rawAddress)
    : validateBitcoinMainnetAddress(rawAddress);
  const amount = chain === "ethereum"
    ? await queryEthereumBalance(address)
    : await queryBitcoinBalance(address);
  return { chain, address, amount };
});

handleIpc("account:initialize-card", async (_event, rawCredential: unknown, rawRecoveryCredential: unknown, rawExpectedSalt: unknown) => {
  const card = await cardBridge("status-profile", "ipi") as CardBridgeStatus;
  const credential = validateCredential(rawCredential);
  const recoveryCredential = validateCredential(rawRecoveryCredential);
  const expectedSalt = validateExpectedSalt(rawExpectedSalt, card);
  try {
    await withCredentialHex(credential, (hex) => withCredentialHex(recoveryCredential, (recoveryHex) => cardBridge("initialize-profile", "ipi", hex, recoveryHex, expectedSalt)));
    const account = await accountSummary();
    if (!account.publicKey) throw new Error("Card public key is unavailable after initialization");
    replaceUnlock(credential, account.publicKey);
    return await accountSummary();
  } finally {
    credential.fill(0);
    recoveryCredential.fill(0);
  }
});

handleIpc("security:recover", async (_event, rawRecoveryCredential: unknown, rawNextCredential: unknown, rawExpectedSalt: unknown) => {
  clearAllUnlocks();
  const card = await cardBridge("status-profile", "ipi") as CardBridgeStatus;
  const recoveryCredential = validateCredential(rawRecoveryCredential);
  const nextCredential = validateCredential(rawNextCredential);
  const expectedSalt = validateExpectedSalt(rawExpectedSalt, card);
  try {
    await withCredentialHex(recoveryCredential, (recoveryHex) => withCredentialHex(nextCredential, (nextHex) => cardBridge("recover-profile", "ipi", recoveryHex, nextHex, expectedSalt)));
    return await accountSummary();
  } finally {
    recoveryCredential.fill(0);
    nextCredential.fill(0);
  }
});

handleIpc("security:unlock", async (_event, rawCredential: unknown, rawExpectedSalt: unknown) => {
  // A review is immutable and already bound to this card's public key. Keep it
  // while the user visits Security to unlock the card for the reviewed action.
  clearUnlockCredential();
  const card = await cardBridge("status-profile", "ipi") as CardBridgeStatus;
  const credential = validateCredential(rawCredential);
  const expectedSalt = validateExpectedSalt(rawExpectedSalt, card);
  try {
    await withCredentialHex(credential, (hex) => cardBridge("verify-profile", "ipi", hex, expectedSalt));
    const account = await accountSummary();
    if (!account.publicKey) throw new Error("Card public key is unavailable");
    replaceUnlock(credential, account.publicKey);
    return await accountSummary();
  } finally {
    credential.fill(0);
  }
});

handleIpc("security:change-password", async (_event, rawCurrentCredential: unknown, rawNextCredential: unknown, rawExpectedSalt: unknown) => {
  const card = await cardBridge("status-profile", "ipi") as CardBridgeStatus;
  const oldCredential = validateCredential(rawCurrentCredential); const newCredential = validateCredential(rawNextCredential);
  const expectedSalt = validateExpectedSalt(rawExpectedSalt, card);
  try {
    await withCredentialHex(oldCredential, (oldHex) => withCredentialHex(
      newCredential,
      (newHex) => cardBridge("change-password-profile", "ipi", oldHex, newHex, expectedSalt),
    ));
    const account = await accountSummary();
    if (!account.publicKey) throw new Error("Card public key is unavailable");
    replaceUnlock(newCredential, account.publicKey);
    return await accountSummary();
  } finally {
    oldCredential.fill(0);
    newCredential.fill(0);
  }
});

handleIpc("security:lock", async () => { clearAllUnlocks(); return accountSummary(); });

handleIpc("account:balance", async (_event, rawAddress: unknown) => {
  const address = validateIpiAddress(rawAddress);
  return { address, amount: await queryBalance(address) };
});

handleIpc("send:review", async (_event, rawRecipient: unknown, rawAmount: unknown) => {
  const account = await accountSummary();
  if (!account.exists || !account.address || !account.publicKey) throw new Error("Insert an initialized IPI Card");
  if (!account.security.supported) throw new Error("The IPI signing profile does not provide password security");
  const recipient = validateIpiAddress(rawRecipient);
  if (recipient === account.address) throw new Error("Recipient must differ from sender");
  const amount = displayAmountToUint128(rawAmount, CHAIN.decimals);
  const [balance, chainAccount, cometStatus] = await Promise.all([
    queryBalance(account.address),
    queryAccount(account.address),
    fetchJson(`${ENDPOINTS.comet}/status`) as Promise<Record<string, any>>,
  ]);
  if (String(cometStatus?.result?.node_info?.network ?? "") !== CHAIN.cosmosChainId) {
    throw new Error("IPI endpoint reported an unexpected chain identity");
  }
  if (BigInt(amount) + BigInt(CHAIN.feeBase) > BigInt(balance)) throw new Error("Amount plus fee exceeds wallet balance");
  const signDoc = makeSignDoc(
    account.address,
    recipient,
    amount,
    Buffer.from(account.publicKey, "hex"),
    chainAccount.accountNumber,
    chainAccount.sequence,
  );
  const reviewId = randomUUID();
  const expiresAt = Date.now() + REVIEW_TTL_MS;
  const review: SendReview = {
    reviewId,
    expiresAt: new Date(expiresAt).toISOString(),
    sender: account.address,
    recipient,
    amount,
    fee: CHAIN.feeBase,
    balance,
    chainId: CHAIN.cosmosChainId,
  };
  pendingReviews.clear();
  pendingReviews.set(reviewId, { review, signDoc, publicKey: account.publicKey, credentialSalt: account.credentialSalt, expiresAt });
  return review;
});

handleIpc("send:execute", async (_event, rawReviewId: unknown) => {
  if (sendInProgress) throw new Error("Another transaction is already in progress");
  const reviewId = validateReviewId(rawReviewId, "transfer");
  sendInProgress = true;
  try {
    const pending = pendingReviews.get(reviewId);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingReviews.delete(reviewId);
      throw new Error("Transfer review expired; review the transaction again");
    }
    const account = await accountSummary();
    if (!account.exists || !account.address || !account.publicKey) throw new Error("Insert an initialized IPI Card");
    if (!account.cardConnected) throw new Error("Insert or tap the IPI Card that opened this wallet session");
    if (!account.security.supported) throw new Error("The IPI signing profile does not provide password security");
    if (account.publicKey !== pending.publicKey || account.address !== pending.review.sender || account.credentialSalt !== pending.credentialSalt) {
      throw new Error("The signing card changed after transaction review");
    }
    const balanceBefore = await queryBalance(account.address);
    if (BigInt(pending.review.amount) + BigInt(CHAIN.feeBase) > BigInt(balanceBefore)) throw new Error("Amount plus fee exceeds wallet balance");
    if (!unlockSession?.matches(pending.publicKey)) throw new Error("Unlock the IPI Card in Security before signing");
    pendingReviews.delete(reviewId);
    const { events: _events, ...result } = await signReviewedTransaction(pending);
    const balanceAfter = await queryBalance(account.address);
    const expectedDelta = BigInt(pending.review.amount) + BigInt(CHAIN.feeBase);
    return {
      ...pending.review,
      ...result,
      balanceBefore,
      balanceAfter,
      balanceDeltaMatches: BigInt(balanceBefore) - BigInt(balanceAfter) === expectedDelta,
      signatureVerified: true,
    };
  } finally {
    sendInProgress = false;
  }
});

function requireVaultAccount(account: Awaited<ReturnType<typeof accountSummary>>): asserts account is typeof account & { address: string; publicKey: string } {
  if (!account.exists || !account.address || !account.publicKey) throw new Error("Insert an initialized IPI Card");
  if (!account.security.supported) throw new Error("The IPI signing profile does not provide password security");
}

function assertIpiChain(cometStatus: Record<string, any>): void {
  if (String(cometStatus?.result?.node_info?.network ?? "") !== CHAIN.cosmosChainId) {
    throw new Error("IPI endpoint reported an unexpected chain identity");
  }
}

function storeVaultReview(
  account: { publicKey: string; credentialSalt: string | null },
  review: Omit<VaultReview, "reviewId" | "expiresAt" | "chainId" | "codeId">,
  signDoc: SignDoc,
): VaultReview {
  if (!CARD_VAULT.codeId) throw new Error("IPI Card Vault code ID is not configured");
  pendingVaultReviews.clear();
  const reviewId = randomUUID();
  const expiresAt = Date.now() + REVIEW_TTL_MS;
  const complete: VaultReview = {
    ...review,
    reviewId,
    expiresAt: new Date(expiresAt).toISOString(),
    chainId: CHAIN.cosmosChainId,
    codeId: CARD_VAULT.codeId,
  };
  pendingVaultReviews.set(reviewId, {
    review: complete,
    signDoc,
    publicKey: account.publicKey,
    credentialSalt: account.credentialSalt,
    expiresAt,
  });
  return complete;
}

async function vaultSigningContext(fee: string, rawVaultAddress?: unknown, allowFeeGrant = true) {
  const account = await accountSummary();
  requireVaultAccount(account);
  const vaultAddress = rawVaultAddress === undefined
    ? null
    : validateIpiAddress(rawVaultAddress, "Vault");
  const [controllerBalance, cometStatus, chainAccount, vaultBalance, vaultHasFeeGrant] = await Promise.all([
    queryBalance(account.address),
    fetchJson(`${ENDPOINTS.comet}/status`) as Promise<Record<string, any>>,
    queryAccount(account.address),
    vaultAddress ? queryBalance(vaultAddress) : Promise.resolve("0"),
    vaultAddress && allowFeeGrant ? hasVaultFeeGrant(vaultAddress, account.address).catch(() => false) : Promise.resolve(false),
  ]);
  assertIpiChain(cometStatus);
  const feeGranter = vaultAddress && vaultHasFeeGrant && BigInt(vaultBalance) >= BigInt(fee)
    ? vaultAddress
    : null;
  if (!feeGranter && BigInt(controllerBalance) < BigInt(fee)) {
    if (!vaultAddress) {
      throw new Error("This card address needs at least 0.00225 test IPI to create the shared account");
    }
    throw new Error("The shared wallet and active card address cannot pay the network fee");
  }
  return { account, controllerBalance, chainAccount, feeGranter };
}

handleIpc("vault:configuration", async () => ({
  available: CARD_VAULT.codeId !== null,
  codeId: CARD_VAULT.codeId,
  chainId: CHAIN.cosmosChainId,
  relayAvailable: PAYMENT_RELAY.codeId !== null,
  relayCodeId: PAYMENT_RELAY.codeId,
  relayCount: PAYMENT_RELAY.count,
}));

handleIpc("vault:status", async (_event, rawContractAddress: unknown) => {
  const account = await accountSummary();
  requireVaultAccount(account);
  return queryVaultStatus(rawContractAddress, account.address);
});

handleIpc("vault:relay-pool-status", async (_event, rawContractAddress: unknown, rawRelays: unknown) => {
  const account = await accountSummary();
  requireVaultAccount(account);
  const status = await queryVaultStatus(rawContractAddress, account.address);
  if (!status.currentMember) throw new Error("Only an active vault card can use its payment relays");
  const relays = await validatePaymentRelayPool(rawRelays, status.contractAddress);
  return {
    vault: status.contractAddress,
    relays: relays.sort((left, right) => left.slot - right.slot).map((relay) => relay.address),
  };
});

handleIpc("vault:review-create", async () => {
  const { account, controllerBalance, chainAccount, feeGranter } = await vaultSigningContext(CARD_VAULT.instantiateFeeBase);
  const signDoc = makeVaultInstantiateSignDoc(
    account.address,
    Buffer.from(account.publicKey, "hex"),
    chainAccount.accountNumber,
    chainAccount.sequence,
  );
  return storeVaultReview(account, {
    action: "create",
    signer: account.address,
    contractAddress: null,
    target: null,
    amount: null,
    fee: CARD_VAULT.instantiateFeeBase,
    feeGranter,
    controllerBalance,
    vaultBalance: null,
  }, signDoc);
});

handleIpc("vault:review-invite", async (_event, rawContractAddress: unknown, rawCardAddress: unknown) => {
  const cardAddress = validateCardAddress(rawCardAddress, "Invited card");
  const { account, controllerBalance, chainAccount, feeGranter } = await vaultSigningContext(CARD_VAULT.executeFeeBase, rawContractAddress);
  if (cardAddress === account.address) throw new Error("The active card is already connected");
  const [status, member, invitation] = await Promise.all([
    queryVaultStatus(rawContractAddress, account.address),
    queryVaultSmart(validateIpiAddress(rawContractAddress, "Vault"), { member: { address: cardAddress } }),
    queryVaultSmart(validateIpiAddress(rawContractAddress, "Vault"), { invitation: { address: cardAddress } }),
  ]);
  if (!status.currentMember) throw new Error("Only an active vault card can invite another card");
  if (member?.member) throw new Error("This card is already active in the vault");
  if (invitation?.invitation) throw new Error("This card already has a pending invitation");
  const requiredVaultBalance = BigInt(feeGranter ? CARD_VAULT.executeFeeBase : "0") + 1n;
  if (BigInt(status.balance) < requiredVaultBalance) {
    throw new Error("The shared wallet needs enough IPI to initialize the invited card controller");
  }
  const signDoc = makeVaultExecuteSignDoc(
    account.address,
    status.contractAddress,
    { invite_card: { address: cardAddress } },
    Buffer.from(account.publicKey, "hex"),
    chainAccount.accountNumber,
    chainAccount.sequence,
    feeGranter,
  );
  return storeVaultReview(account, {
    action: "invite",
    signer: account.address,
    contractAddress: status.contractAddress,
    target: cardAddress,
    amount: null,
    fee: CARD_VAULT.executeFeeBase,
    feeGranter,
    controllerBalance,
    vaultBalance: status.balance,
  }, signDoc);
});

handleIpc("vault:review-accept", async (_event, rawContractAddress: unknown) => {
  const { account, controllerBalance, chainAccount, feeGranter } = await vaultSigningContext(CARD_VAULT.executeFeeBase, rawContractAddress);
  const status = await queryVaultStatus(rawContractAddress, account.address);
  if (status.currentMember) throw new Error("This card is already active in the vault");
  if (!status.currentInvitation) throw new Error("This card has no pending invitation");
  const signDoc = makeVaultExecuteSignDoc(
    account.address,
    status.contractAddress,
    { accept_invitation: {} },
    Buffer.from(account.publicKey, "hex"),
    chainAccount.accountNumber,
    chainAccount.sequence,
    feeGranter,
  );
  return storeVaultReview(account, {
    action: "accept",
    signer: account.address,
    contractAddress: status.contractAddress,
    target: account.address,
    amount: null,
    fee: CARD_VAULT.executeFeeBase,
    feeGranter,
    controllerBalance,
    vaultBalance: status.balance,
  }, signDoc);
});

handleIpc("vault:review-cancel", async (_event, rawContractAddress: unknown, rawCardAddress: unknown) => {
  const cardAddress = validateCardAddress(rawCardAddress, "Invited card");
  const { account, controllerBalance, chainAccount, feeGranter } = await vaultSigningContext(CARD_VAULT.executeFeeBase, rawContractAddress);
  const status = await queryVaultStatus(rawContractAddress, account.address);
  if (!status.currentMember) throw new Error("Only an active vault card can cancel an invitation");
  const invitation = await queryVaultSmart(status.contractAddress, { invitation: { address: cardAddress } });
  if (!invitation?.invitation) throw new Error("This card no longer has a pending invitation");
  const signDoc = makeVaultExecuteSignDoc(
    account.address,
    status.contractAddress,
    { cancel_invitation: { address: cardAddress } },
    Buffer.from(account.publicKey, "hex"),
    chainAccount.accountNumber,
    chainAccount.sequence,
    feeGranter,
  );
  return storeVaultReview(account, {
    action: "cancel",
    signer: account.address,
    contractAddress: status.contractAddress,
    target: cardAddress,
    amount: null,
    fee: CARD_VAULT.executeFeeBase,
    feeGranter,
    controllerBalance,
    vaultBalance: status.balance,
  }, signDoc);
});

handleIpc("vault:review-remove", async (_event, rawContractAddress: unknown, rawCardAddress: unknown) => {
  const cardAddress = validateCardAddress(rawCardAddress, "Removed card");
  const { account, controllerBalance, chainAccount, feeGranter } = await vaultSigningContext(CARD_VAULT.executeFeeBase, rawContractAddress);
  const status = await queryVaultStatus(rawContractAddress, account.address);
  if (!status.currentMember) throw new Error("Only an active vault card can remove a card");
  if (status.memberCount <= 1) throw new Error("The final active card cannot be removed");
  const member = await queryVaultSmart(status.contractAddress, { member: { address: cardAddress } });
  if (!member?.member) throw new Error("This card is no longer active in the vault");
  const signDoc = makeVaultExecuteSignDoc(
    account.address,
    status.contractAddress,
    { remove_card: { address: cardAddress } },
    Buffer.from(account.publicKey, "hex"),
    chainAccount.accountNumber,
    chainAccount.sequence,
    feeGranter,
  );
  return storeVaultReview(account, {
    action: "remove",
    signer: account.address,
    contractAddress: status.contractAddress,
    target: cardAddress,
    amount: null,
    fee: CARD_VAULT.executeFeeBase,
    feeGranter,
    controllerBalance,
    vaultBalance: status.balance,
  }, signDoc);
});

handleIpc("vault:review-setup-relays", async (_event, rawContractAddress: unknown) => {
  if (!PAYMENT_RELAY.codeId) throw new Error("IPI Payment Relay code ID is not configured");
  const { account, controllerBalance, chainAccount, feeGranter } = await vaultSigningContext(
    PAYMENT_RELAY.setupFeeBase,
    rawContractAddress,
    false,
  );
  if (feeGranter) throw new Error("Payment relay setup must be paid by the active card address");
  const status = await queryVaultStatus(rawContractAddress, account.address);
  if (!status.currentMember) throw new Error("Only an active vault card can create its payment relays");
  const signDoc = makeRelaySetupSignDoc(
    account.address,
    status.contractAddress,
    Buffer.from(account.publicKey, "hex"),
    chainAccount.accountNumber,
    chainAccount.sequence,
  );
  return storeVaultReview(account, {
    action: "setup-relays",
    signer: account.address,
    contractAddress: status.contractAddress,
    target: null,
    amount: null,
    fee: PAYMENT_RELAY.setupFeeBase,
    feeGranter: null,
    controllerBalance,
    vaultBalance: status.balance,
    relayCodeId: PAYMENT_RELAY.codeId,
  }, signDoc);
});

handleIpc("vault:review-relay-transfer", async (
  _event,
  rawContractAddress: unknown,
  rawRelays: unknown,
  rawRecipient: unknown,
  rawAmount: unknown,
) => {
  if (!PAYMENT_RELAY.codeId) throw new Error("IPI Payment Relay code ID is not configured");
  const recipient = validateIpiAddress(rawRecipient);
  const amount = displayAmountToUint128(rawAmount, CHAIN.decimals);
  const [{ account, controllerBalance, chainAccount, feeGranter }, relays] = await Promise.all([
    vaultSigningContext(PAYMENT_RELAY.paymentFeeBase, rawContractAddress),
    validatePaymentRelayPool(rawRelays, rawContractAddress),
  ]);
  const status = await queryVaultStatus(rawContractAddress, account.address);
  if (!status.currentMember) throw new Error("Only an active vault card can transfer shared funds");
  if (recipient === status.contractAddress || recipient === account.address || relays.some((relay) => relay.address === recipient)) {
    throw new Error("Recipient must differ from the vault, active card and payment relays");
  }
  const spendableBalance = BigInt(status.balance) - BigInt(feeGranter ? PAYMENT_RELAY.paymentFeeBase : "0");
  if (BigInt(amount) > spendableBalance) throw new Error("Amount plus the network fee exceeds the shared vault balance");
  const route = shuffledRelayAddresses(relays);
  const paymentId = randomBytes(32).toString("hex");
  const signDoc = makeRelayPaymentSignDoc(
    account.address,
    status.contractAddress,
    route,
    recipient,
    amount,
    paymentId,
    Buffer.from(account.publicKey, "hex"),
    chainAccount.accountNumber,
    chainAccount.sequence,
    feeGranter,
  );
  return storeVaultReview(account, {
    action: "relay-transfer",
    signer: account.address,
    contractAddress: status.contractAddress,
    target: recipient,
    amount,
    fee: PAYMENT_RELAY.paymentFeeBase,
    feeGranter,
    controllerBalance,
    vaultBalance: status.balance,
    relayCodeId: PAYMENT_RELAY.codeId,
    route,
    paymentId,
  }, signDoc);
});

handleIpc("vault:execute", async (_event, rawReviewId: unknown) => {
  if (sendInProgress) throw new Error("Another transaction is already in progress");
  const reviewId = validateReviewId(rawReviewId, "vault");
  sendInProgress = true;
  try {
    const pending = pendingVaultReviews.get(reviewId);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingVaultReviews.delete(reviewId);
      throw new Error("Vault review expired; review the operation again");
    }
    if (pending.review.codeId !== CARD_VAULT.codeId) throw new Error("Vault code configuration changed after review");
    if ((pending.review.action === "setup-relays" || pending.review.action === "relay-transfer")
      && pending.review.relayCodeId !== PAYMENT_RELAY.codeId) {
      throw new Error("Payment relay code configuration changed after review");
    }
    const account = await accountSummary();
    requireVaultAccount(account);
    if (!account.cardConnected) throw new Error("Insert or tap the IPI Card that opened this wallet session");
    if (account.address !== pending.review.signer || account.publicKey !== pending.publicKey || account.credentialSalt !== pending.credentialSalt) {
      throw new Error("The signing card changed after vault review");
    }
    if (pending.review.feeGranter) {
      if (pending.review.feeGranter !== pending.review.contractAddress) {
        throw new Error("The reviewed fee granter does not match the shared wallet");
      }
      const [feeBalance, grantExists] = await Promise.all([
        queryBalance(pending.review.feeGranter),
        hasVaultFeeGrant(pending.review.feeGranter, account.address),
      ]);
      if (!grantExists) throw new Error("The shared wallet fee grant is no longer available");
      if (BigInt(feeBalance) < BigInt(pending.review.fee)) {
        throw new Error("The shared wallet can no longer pay the network fee");
      }
    } else {
      const controllerBalance = await queryBalance(account.address);
      if (BigInt(controllerBalance) < BigInt(pending.review.fee)) {
        throw new Error("The active card address cannot pay the network fee");
      }
    }
    if (pending.review.contractAddress) {
      const status = await queryVaultStatus(pending.review.contractAddress, account.address);
      if (pending.review.action === "invite" && !status.currentMember) throw new Error("The active card is no longer a vault member");
      if (pending.review.action === "invite") {
        const requiredVaultBalance = BigInt(pending.review.feeGranter ? pending.review.fee : "0") + 1n;
        if (BigInt(status.balance) < requiredVaultBalance) throw new Error("The shared wallet can no longer initialize the invited card controller");
      }
      if (pending.review.action === "accept" && !status.currentInvitation) throw new Error("The invitation is no longer valid");
      if (pending.review.action === "cancel") {
        if (!status.currentMember) throw new Error("The active card is no longer a vault member");
        if (!pending.review.target) throw new Error("The reviewed invitation target is missing");
        const invitation = await queryVaultSmart(status.contractAddress, { invitation: { address: pending.review.target } });
        if (!invitation?.invitation) throw new Error("The invitation no longer exists");
      }
      if (pending.review.action === "remove") {
        if (!status.currentMember) throw new Error("The active card is no longer a vault member");
        if (status.memberCount <= 1) throw new Error("The final active card cannot be removed");
        if (!pending.review.target) throw new Error("The reviewed card target is missing");
        const member = await queryVaultSmart(status.contractAddress, { member: { address: pending.review.target } });
        if (!member?.member) throw new Error("The card is no longer a vault member");
      }
      if (pending.review.action === "setup-relays" && !status.currentMember) {
        throw new Error("The active card is no longer a vault member");
      }
      if (pending.review.action === "relay-transfer") {
        if (!status.currentMember) throw new Error("The active card is no longer a vault member");
        if (!pending.review.route || pending.review.route.length !== PAYMENT_RELAY.count) {
          throw new Error("The reviewed payment relay route is incomplete");
        }
        await validatePaymentRelayPool(pending.review.route, status.contractAddress);
        const spendableBalance = BigInt(status.balance) - BigInt(pending.review.feeGranter ? pending.review.fee : "0");
        if (!pending.review.amount || BigInt(pending.review.amount) > spendableBalance) {
          throw new Error("The vault balance changed after review");
        }
      }
    }
    if (!unlockSession?.matches(pending.publicKey)) throw new Error("Unlock the IPI Card in Security before signing");
    pendingVaultReviews.delete(reviewId);
    const signed = await signReviewedTransaction(pending);
    const contractAddress = pending.review.action === "create"
      ? instantiatedContractAddress(signed.events)
      : pending.review.contractAddress;
    if (!contractAddress) throw new Error("Vault address is unavailable after confirmation");
    await verifyVaultContract(contractAddress);
    let relayAddresses: string[] | undefined;
    if (pending.review.action === "setup-relays") {
      try {
        const created = instantiatedContractAddresses(signed.events, "Created payment relay");
        if (created.length !== PAYMENT_RELAY.count) {
          throw new Error("relay setup transaction did not report exactly five contracts");
        }
        const relays = await validatePaymentRelayPool(created, contractAddress);
        relayAddresses = relays.sort((left, right) => left.slot - right.slot).map((relay) => relay.address);
      } catch (error) {
        throw new Error(`Transaction ${signed.txHash} is confirmed, but relay discovery failed: ${error instanceof Error ? error.message : "unknown error"}. Do not retry; recover the five addresses from this transaction`);
      }
    }
    if (pending.review.action === "relay-transfer") {
      try {
        verifyRelayPaymentEvents(signed.events, pending.review);
      } catch (error) {
        throw new Error(`Payment transaction ${signed.txHash} is confirmed, but public event verification failed: ${error instanceof Error ? error.message : "unknown error"}. Do not send it again`);
      }
    }
    return {
      ...pending.review,
      txHash: signed.txHash,
      height: signed.height,
      contractAddress,
      relayAddresses,
      signatureVerified: true,
    };
  } finally {
    sendInProgress = false;
  }
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#080d1d",
    title: "IPI Wallet — Testnet",
    icon: appIconPath,
    show: false,
    webPreferences: {
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: isDevelopment,
    },
  });
  mainWindow = window;

  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("blur", clearAllUnlocks);
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.once("did-finish-load", () => startCardWatcher(window));

  if (isDevelopment) void window.loadURL("http://127.0.0.1:5173");
  else void window.loadFile(join(currentDir, "../dist/index.html"));
}

function startCardWatcher(window: BrowserWindow): void {
  if (window.isDestroyed() || applicationQuitting) return;
  if (cardWatcherRestartTimer) clearTimeout(cardWatcherRestartTimer);
  cardWatcherRestartTimer = null;
  const previousWatcher = cardWatcher;
  cardWatcher = null;
  previousWatcher?.kill();
  const watcher = spawn(pythonExecutable, [cardBridgePath, "watch"], { env: hardenedPythonEnvironment() });
  cardWatcher = watcher;
  let pending = "";
  watcher.stdout.setEncoding("utf8");
  watcher.stderr.resume();
  watcher.stdout.on("data", (chunk: string) => {
    pending += chunk;
    if (Buffer.byteLength(pending) > 64 * 1024) {
      pending = "";
      watcher.kill();
      return;
    }
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as { event?: string; reader?: string };
        // The ACR1281U exposes sibling PC/SC slots. Opening the active slot can
        // briefly toggle another slot, which must not be interpreted as a
        // physical card removal/reinsertion or it creates a refresh loop.
        if (activeCardReader && message.reader && message.reader !== activeCardReader) {
          if (message.event === "removed" || activeCardHasIpiApplet) continue;
        }
        if (message.event === "inserted") {
          if (removalConfirmationTimer) {
            clearTimeout(removalConfirmationTimer);
            removalConfirmationTimer = null;
          }
          // If this was only a reset of the active slot, renderer-side
          // debouncing coalesces it with its matching removal.
          window.webContents.send("card:changed");
        } else if (message.event === "removed") {
          if (removalConfirmationTimer) clearTimeout(removalConfirmationTimer);
          const resetGuardRemaining = Math.max(0, ignoreCardEventsUntil - Date.now());
          const delay = Math.max(750, resetGuardRemaining + 150);
          const removedReader = message.reader;
          removalConfirmationTimer = setTimeout(() => {
            removalConfirmationTimer = null;
            clearAllUnlocks();
            void accountSummary().then((current) => {
              if (!current.cardConnected || current.reader !== removedReader) window.webContents.send("card:changed");
            });
          }, cardOperationActive ? Math.max(delay, 1_000) : delay);
        }
      } catch { /* Ignore malformed helper output. */ }
    }
  });
  watcher.once("exit", () => {
    if (cardWatcher !== watcher) return;
    cardWatcher = null;
    if (applicationQuitting || window.isDestroyed()) return;
    window.webContents.send("card:changed");
    cardWatcherRestartTimer = setTimeout(() => startCardWatcher(window), 1_500);
  });
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  powerMonitor.on("lock-screen", clearAllUnlocks);
  powerMonitor.on("suspend", clearAllUnlocks);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  applicationQuitting = true;
  sendInProgress = false;
  clearAllUnlocks();
  cardWatcher?.kill();
  cardWatcher = null;
  if (cardWatcherRestartTimer) clearTimeout(cardWatcherRestartTimer);
  cardWatcherRestartTimer = null;
  if (removalConfirmationTimer) clearTimeout(removalConfirmationTimer);
  removalConfirmationTimer = null;
});
