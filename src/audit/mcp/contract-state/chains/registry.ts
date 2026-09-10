/**
 * Lightweight chain registry.
 *
 * Each entry pins an RPC URL and the explorer base used by the metadata
 * providers. RPC URLs are taken from environment variables so users can
 * plug in their own Alchemy/Infura endpoint without editing code.
 */

import type { Address } from "../storage/types";

export interface ChainConfig {
  chainId: number;
  name: string;
  /** Native currency symbol (display only). */
  symbol: string;
  rpcUrl: string;
  /** Public fallback endpoints used when RPC_<chainId> is not configured. */
  publicRpcUrls?: string[];
  /** Etherscan-compatible API base, e.g. `https://api.etherscan.io/api`. */
  etherscanApiUrl?: string;
  /** Sourcify server URL. */
  sourcifyApiUrl?: string;
  /** Blockscout API base (optional). */
  blockscoutApiUrl?: string;
}

const DEFAULT_SOURCIFY = "https://sourcify.dev/server";

/** Build the chain config from env vars or throw with a clear message. */
function fromEnv(
  chainId: number,
  name: string,
  symbol: string,
  defaults: { rpcUrl?: string; publicRpcUrls?: string[]; etherscan?: string },
): ChainConfig {
  const envRpc =
    process.env[`RPC_${chainId}`] ?? process.env[`RPC_URL_${chainId}`];
  const rpcUrl =
    envRpc ??
    defaults.rpcUrl ??
    defaults.publicRpcUrls?.find((url) => url.trim().length > 0);
  if (!rpcUrl) {
    throw new Error(
      `No RPC URL configured for chain ${chainId} (${name}). Set RPC_${chainId}=https://... in the environment.`,
    );
  }
  const envEtherscan =
    process.env[`ETHERSCAN_API_URL_${chainId}`] ?? defaults.etherscan;
  return {
    chainId,
    name,
    symbol,
    rpcUrl,
    etherscanApiUrl: envEtherscan,
    sourcifyApiUrl: DEFAULT_SOURCIFY,
  };
}

const BUILTIN: Record<number, Omit<ChainConfig, "rpcUrl">> = {
  1: {
    chainId: 1,
    name: "Ethereum Mainnet",
    symbol: "ETH",
    etherscanApiUrl: "https://api.etherscan.io/api",
    publicRpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
    ],
  },
  10: {
    chainId: 10,
    name: "Optimism",
    symbol: "ETH",
    etherscanApiUrl: "https://api-optimistic.etherscan.io/api",
    publicRpcUrls: [
      "https://optimism-rpc.publicnode.com",
      "https://optimism.llamarpc.com",
      "https://rpc.ankr.com/optimism",
    ],
  },
  56: {
    chainId: 56,
    name: "BNB Smart Chain",
    symbol: "BNB",
    etherscanApiUrl: "https://api.etherscan.io/v2/api?chainid=56",
    publicRpcUrls: [
      "https://bsc-rpc.publicnode.com",
      "https://bsc-dataseed.binance.org",
      "https://binance.llamarpc.com",
    ],
  },
  137: {
    chainId: 137,
    name: "Polygon",
    symbol: "MATIC",
    etherscanApiUrl: "https://api.polygonscan.com/api",
    publicRpcUrls: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.llamarpc.com",
      "https://rpc.ankr.com/polygon",
    ],
  },
  8453: {
    chainId: 8453,
    name: "Base",
    symbol: "ETH",
    etherscanApiUrl: "https://api.basescan.org/api",
    publicRpcUrls: [
      "https://base-rpc.publicnode.com",
      "https://base.llamarpc.com",
      "https://rpc.ankr.com/base",
    ],
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    symbol: "ETH",
    etherscanApiUrl: "https://api.arbiscan.io/api",
    publicRpcUrls: [
      "https://arbitrum-one-rpc.publicnode.com",
      "https://arbitrum.llamarpc.com",
      "https://rpc.ankr.com/arbitrum",
    ],
  },
  11155111: {
    chainId: 11155111,
    name: "Ethereum Sepolia",
    symbol: "SepoliaETH",
    etherscanApiUrl: "https://api-sepolia.etherscan.io/api",
    publicRpcUrls: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://sepolia.gateway.tenderly.co",
      "https://rpc.sepolia.org",
    ],
  },
  17000: {
    chainId: 17000,
    name: "Ethereum Holesky",
    symbol: "HolETH",
    etherscanApiUrl: "https://api-holesky.etherscan.io/api",
    publicRpcUrls: [
      "https://ethereum-holesky-rpc.publicnode.com",
      "https://rpc.ankr.com/eth_holesky",
    ],
  },
};

/**
 * Resolve chain config for a given chainId. If `overrideRpc` is set it wins
 * over environment + builtin defaults, which is useful for tests.
 */
export function getChain(chainId: number, overrideRpc?: string): ChainConfig {
  const builtin = BUILTIN[chainId];
  if (builtin) {
    return fromEnv(chainId, builtin.name, builtin.symbol, {
      rpcUrl: overrideRpc,
      publicRpcUrls:
        "publicRpcUrls" in builtin ? builtin.publicRpcUrls : undefined,
      etherscan: builtin.etherscanApiUrl,
    });
  }
  if (overrideRpc) {
    return {
      chainId,
      name: `Chain ${chainId}`,
      symbol: "UNKNOWN",
      rpcUrl: overrideRpc,
      sourcifyApiUrl: DEFAULT_SOURCIFY,
    };
  }
  // Unknown chain but env-provided RPC is fine.
  return fromEnv(chainId, `Chain ${chainId}`, "UNKNOWN", {});
}

/** Used by the MCP tool to validate chainId up front. */
export function isKnownChain(chainId: number): boolean {
  return chainId in BUILTIN || Boolean(process.env[`RPC_${chainId}`]);
}

export type { Address };
