export const CHAIN = Object.freeze({
  cosmosChainId: "ipi-testnet-1",
  evmChainId: 42_424,
  baseDenom: "aipi",
  displayDenom: "IPI",
  decimals: 18,
  feeBase: "300000000000000",
  gasLimit: 200_000n,
  bech32Prefix: "ipi",
  publicKeyTypeUrl: "/cosmos.evm.crypto.v1.ethsecp256k1.PubKey",
});

function secureEndpoint(name: string, fallback: string): string {
  const raw = process.env[name] ?? fallback;
  const endpoint = new URL(raw);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error(`${name} must be an HTTPS URL without credentials, a query or a fragment`);
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
  return endpoint.toString().replace(/\/$/, "");
}

function optionalPositiveInteger(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return raw;
}

export const CARD_VAULT = Object.freeze({
  codeId: optionalPositiveInteger("IPI_CARD_VAULT_CODE_ID"),
  executeFeeBase: "1200000000000000",
  executeGasLimit: 800_000n,
  instantiateFeeBase: "2250000000000000",
  instantiateGasLimit: 1_500_000n,
});

export const ENDPOINTS = Object.freeze({
  comet: secureEndpoint("IPI_COMET_ENDPOINT", "https://rpc-testnet.ipi.io"),
  evm: secureEndpoint("IPI_EVM_ENDPOINT", "https://evm-rpc-testnet.ipi.io"),
  rest: secureEndpoint("IPI_REST_ENDPOINT", "https://rest-testnet.ipi.io"),
  ethereumMainnet: secureEndpoint("IPI_ETHEREUM_MAINNET_RPC", "https://ethereum-rpc.publicnode.com"),
  bitcoinMainnet: secureEndpoint("IPI_BITCOIN_MAINNET_API", "https://mempool.space/api"),
});

export const NETWORK_ORIGINS = new Set(Object.values(ENDPOINTS).map((endpoint) => new URL(endpoint).origin));
