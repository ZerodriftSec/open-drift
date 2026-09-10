/**
 * Sourcify metadata adapter.
 *
 * Sourcify exposes verified contracts at:
 *   GET {server}/files/any/{chainId}/{address}
 *
 * The response is an array of file descriptors, including:
 *   - metadata.json (solc standard JSON output + compiler info)
 *   - the original source files
 *
 * Sourcify is free and requires no API key, which makes it a good first
 * fallback before hitting Etherscan.
 */

import type { Address } from "../storage/types";
import type {
  ContractMetadata,
  ContractMetadataProvider,
  SourceFile,
} from "./provider";

interface SourcifyFile {
  name: string;
  path: string;
  content: string;
}

interface SourcifyMetadata {
  compiler?: { version?: string };
  settings?: {
    optimizer?: { enabled?: boolean; runs?: number };
    viaIR?: boolean;
    evmVersion?: string;
    libraries?: Record<string, Record<string, string>>;
    compilationTarget?: Record<string, string>;
  };
  output?: {
    abi?: unknown[];
  };
  sources?: Record<string, { content: string }>;
}

interface SourcifyV2Contract {
  abi?: unknown[];
  address?: string;
  chainId?: string | number;
  compilation?: {
    compilerSettings?: {
      evmVersion?: string;
      libraries?: Record<string, Record<string, string>>;
      optimizer?: { enabled?: boolean; runs?: number };
      viaIR?: boolean;
    };
    compilerVersion?: string;
    fullyQualifiedName?: string;
    name?: string;
  };
  metadata?: SourcifyMetadata;
  sources?: Record<string, { content: string }>;
  stdJsonInput?: unknown;
}

export class SourcifyMetadataProvider implements ContractMetadataProvider {
  readonly name = "sourcify";
  constructor(
    private readonly apiUrl = "https://sourcify.dev/server",
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async getContractMetadata(
    chainId: number,
    address: Address,
  ): Promise<ContractMetadata | null> {
    const v2 = await this.getV2ContractMetadata(chainId, address);
    if (v2) {
      return v2;
    }

    const url = `${this.apiUrl}/files/any/${chainId}/${address.toLowerCase()}`;
    const res = await this.fetchImpl(url);
    if (res.status === 404) return null;
    if (res.status === 503) return null;
    if (!res.ok) {
      throw new Error(`sourcify: HTTP ${res.status} for ${address}`);
    }
    const files = (await res.json()) as SourcifyFile[];

    const metadataFile = files.find((f) => f.name === "metadata.json");
    if (!metadataFile) {
      // Some Sourcify responses only include sources, not metadata.json.
      // We can still reconstruct sources but cannot recompile without
      // compiler settings. Bail and let Etherscan try.
      return null;
    }

    const metadata = JSON.parse(metadataFile.content) as SourcifyMetadata;
    const version = metadata.compiler?.version ?? "0.8.24";
    const target =
      Object.entries(metadata.settings?.compilationTarget ?? {}).find(
        Boolean,
      ) ?? [];

    const sources: SourceFile[] = [];
    if (metadata.sources) {
      for (const [path, src] of Object.entries(metadata.sources)) {
        sources.push({ path, content: src.content });
      }
    }
    // Also pick up any source files Sourcify returned explicitly.
    for (const f of files) {
      if (f.name === "metadata.json") continue;
      if (sources.some((s) => s.path === f.path)) continue;
      sources.push({ path: f.path, content: f.content });
    }

    const contractName =
      target[1] ??
      sources[0]?.path?.split("/").pop()?.replace(".sol", "") ??
      "Unknown";

    return {
      chainId,
      address,
      contractName,
      compiler: {
        version,
        optimizer: metadata.settings?.optimizer
          ? {
              enabled: Boolean(metadata.settings.optimizer.enabled),
              runs: metadata.settings.optimizer.runs,
            }
          : undefined,
        viaIR: metadata.settings?.viaIR,
        evmVersion: metadata.settings?.evmVersion,
        libraries: metadata.settings?.libraries,
      },
      sources,
      abi: metadata.output?.abi ?? [],
      provider: "sourcify",
      targetContractPath: target[0],
    };
  }

  private async getV2ContractMetadata(
    chainId: number,
    address: Address,
  ): Promise<ContractMetadata | null> {
    const url = `${this.apiUrl}/v2/contract/${chainId}/${address.toLowerCase()}?fields=all`;
    const res = await this.fetchImpl(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`sourcify v2: HTTP ${res.status} for ${address}`);
    }

    const contract = (await res.json()) as SourcifyV2Contract;
    const sources = Object.entries(contract.sources ?? {}).map(
      ([path, source]) => ({
        path,
        content: source.content,
      }),
    );
    const fullyQualifiedName =
      contract.compilation?.fullyQualifiedName ??
      Object.entries(contract.metadata?.settings?.compilationTarget ?? {})
        .map(([path, name]) => `${path}:${name}`)
        .find(Boolean);
    const [targetContractPath, targetContractName] =
      splitFullyQualifiedName(fullyQualifiedName);
    const compilerVersion =
      contract.compilation?.compilerVersion ??
      contract.metadata?.compiler?.version ??
      "0.8.24";
    const optimizer =
      contract.compilation?.compilerSettings?.optimizer ??
      contract.metadata?.settings?.optimizer;

    return {
      chainId,
      address,
      abi: contract.abi ?? contract.metadata?.output?.abi ?? [],
      compiler: {
        version: compilerVersion,
        optimizer: optimizer
          ? {
              enabled: Boolean(optimizer.enabled),
              runs: optimizer.runs,
            }
          : undefined,
        viaIR:
          contract.compilation?.compilerSettings?.viaIR ??
          contract.metadata?.settings?.viaIR,
        evmVersion:
          contract.compilation?.compilerSettings?.evmVersion ??
          contract.metadata?.settings?.evmVersion,
        libraries:
          contract.compilation?.compilerSettings?.libraries ??
          contract.metadata?.settings?.libraries,
      },
      contractName:
        targetContractName ??
        contract.compilation?.name ??
        sources[0]?.path?.split("/").pop()?.replace(".sol", "") ??
        "Unknown",
      provider: "sourcify-v2",
      sources,
      standardJsonInput: contract.stdJsonInput,
      targetContractPath,
    };
  }
}

function splitFullyQualifiedName(
  fullyQualifiedName: string | undefined,
): [string | undefined, string | undefined] {
  if (!fullyQualifiedName) {
    return [undefined, undefined];
  }

  const index = fullyQualifiedName.lastIndexOf(":");
  if (index < 0) {
    return [undefined, fullyQualifiedName];
  }

  return [
    fullyQualifiedName.slice(0, index),
    fullyQualifiedName.slice(index + 1),
  ];
}
