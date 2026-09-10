/**
 * Contract metadata provider abstraction.
 *
 * A metadata provider returns everything we need to recompile a contract
 * locally so we can read solc's storageLayout. Concrete adapters (Etherscan,
 * Sourcify) live in the `./adapters` directory.
 */

import type { Address } from "../storage/types";

export interface SourceFile {
  path: string;
  content: string;
}

export interface CompilerSettings {
  version: string;
  optimizer?: { enabled: boolean; runs?: number };
  viaIR?: boolean;
  evmVersion?: string;
  libraries?: Record<string, Record<string, string>>;
}

export interface ContractMetadata {
  chainId: number;
  address: Address;
  contractName: string;
  compiler: CompilerSettings;
  sources: SourceFile[];
  abi: unknown[];
  /** Constructor args as hex, if available. */
  constructorArguments?: `0x${string}`;
  /** Where the metadata came from (for diagnostics). */
  provider: string;
  /**
   * Optional pre-computed standard-json input from the explorer. If present,
   * the compiler can skip the assembly step and use it directly.
   */
  standardJsonInput?: unknown;
  /**
   * Target contract path within the sources. Sourcify/Etherscan sometimes
   * return this explicitly; otherwise we derive it from contractName.
   */
  targetContractPath?: string;
}

export interface ContractMetadataProvider {
  readonly name: string;
  getContractMetadata(
    chainId: number,
    address: Address,
  ): Promise<ContractMetadata | null>;
}

export class MetadataError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MetadataError";
  }
}

/**
 * Compose multiple providers; returns the first non-null result. Useful for
 * trying Sourcify (free) before Etherscan (needs API key).
 */
export class ChainedMetadataProvider implements ContractMetadataProvider {
  readonly name = "chained";
  constructor(private readonly providers: ContractMetadataProvider[]) {}

  async getContractMetadata(
    chainId: number,
    address: Address,
  ): Promise<ContractMetadata | null> {
    for (const p of this.providers) {
      try {
        const meta = await p.getContractMetadata(chainId, address);
        if (meta) return meta;
      } catch {
        // Continue to next provider; surface as warning at call site.
        continue;
      }
    }
    return null;
  }
}

export type { Address };
