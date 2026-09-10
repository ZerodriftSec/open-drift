import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  contractStateSnapshotDescription,
  contractStateSnapshotInputSchema,
  createContractStateSnapshotHandler,
} from "./tools/contract-state-snapshot";
import {
  contractStateMcpServerName,
  contractStateSnapshotToolName,
} from "./catalog";
import {
  ChainedMetadataProvider,
  type ContractMetadataProvider,
} from "./metadata/provider";
import { SourcifyMetadataProvider } from "./metadata/sourcify";
import { EtherscanMetadataProvider } from "./metadata/etherscan";
import { getChain } from "./chains/registry";
import { startMcpHttpServer } from "../http-runtime";

export { contractStateMcpServerName } from "./catalog";

export interface ServerOptions {
  /** Optional override metadata provider. Defaults to Sourcify → Etherscan. */
  metadataProvider?: ContractMetadataProvider;
}

export function buildDefaultMetadataProvider() {
  const sourcify = new SourcifyMetadataProvider();
  const etherscanPerChain: Record<number, string> = {};
  // Etherscan is configured per-chain. We discover which chains have URLs
  // at call-time, so we pass the whole map.
  for (const chainId of [1, 10, 137, 8453, 42161, 11155111, 17000]) {
    try {
      const cfg = getChain(chainId);
      if (cfg.etherscanApiUrl) etherscanPerChain[chainId] = cfg.etherscanApiUrl;
    } catch {
      // chain not configured; skip
    }
  }
  const etherscan = new EtherscanMetadataProvider(
    undefined,
    globalThis.fetch,
    etherscanPerChain,
  );
  return new ChainedMetadataProvider([sourcify, etherscan]);
}

export function createContractStateMcpServer(
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: contractStateMcpServerName, version: "0.1.0" },
    { instructions: contractStateSnapshotDescription },
  );
  const provider = options.metadataProvider ?? buildDefaultMetadataProvider();
  server.registerTool(
    contractStateSnapshotToolName,
    {
      title: "Contract State Snapshot",
      description: contractStateSnapshotDescription,
      inputSchema: contractStateSnapshotInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createContractStateSnapshotHandler({ metadataProvider: provider }),
  );
  return server;
}

let contractStateMcpUrlPromise: Promise<string> | undefined;

export function getContractStateMcpUrl() {
  contractStateMcpUrlPromise ??= startMcpHttpServer({
    createMcpServer: () => createContractStateMcpServer(),
  });
  return contractStateMcpUrlPromise;
}
