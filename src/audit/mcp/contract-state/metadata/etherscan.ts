/**
 * Etherscan-family metadata adapter.
 *
 * Etherscan exposes verified source via the `getsourcecode` module:
 *   GET {api}?module=contract&action=getsourcecode&address=...&apikey=...
 *
 * The response item contains:
 *   - SourceCode: either plain source, multi-file JSON, or solc standard JSON
 *   - ABI: JSON string
 *   - CompilerVersion, Optimizer, Runs, ConstructorArguments, etc.
 *
 * Multi-file source uses the double-brace `{{ ... }}` envelope; standard
 * JSON input is wrapped in triple braces `{{{ ... }}}`.
 */

import type { Address } from "../storage/types";
import type {
  CompilerSettings,
  ContractMetadata,
  ContractMetadataProvider,
  SourceFile,
} from "./provider";

interface EtherscanSourceItem {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string; // "0" | "1"
  Runs: string;
  ConstructorArguments: string;
  EVMVersion: string;
  Library: string;
  Proxy: string; // "1" if proxy
  Implementation: string;
  FileName?: string;
}

interface EtherscanResponse {
  status: string;
  message: string;
  result: EtherscanSourceItem[] | string;
}

export class EtherscanMetadataProvider implements ContractMetadataProvider {
  readonly name = "etherscan";
  constructor(
    private readonly apiKey: string | undefined = process.env.ETHERSCAN_API_KEY,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly perChainApiUrl: Record<number, string> = {},
  ) {}

  async getContractMetadata(
    chainId: number,
    address: Address,
  ): Promise<ContractMetadata | null> {
    const base = this.perChainApiUrl[chainId];
    if (!base) return null; // Not configured for this chain
    const apiKeyParam = this.apiKey ? `&apikey=${this.apiKey}` : "";
    const url = `${base}?module=contract&action=getsourcecode&address=${address}${apiKeyParam}`;

    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`etherscan: HTTP ${res.status} for ${address}`);
    }
    const json = (await res.json()) as EtherscanResponse;
    if (json.status !== "1" || !Array.isArray(json.result)) {
      return null;
    }
    const item = json.result[0];
    if (!item || item.ABI === "Contract source code not verified") {
      return null;
    }

    const { sources, standardJsonInput, targetPath } = parseSourceCode(
      item.SourceCode,
      item.FileName,
    );

    const optimizer =
      item.OptimizationUsed === "1"
        ? { enabled: true, runs: Number(item.Runs) || 200 }
        : { enabled: false, runs: 200 };

    const settings: CompilerSettings = {
      version: item.CompilerVersion.replace(/^v/, ""),
      optimizer,
      evmVersion: item.EVMVersion || undefined,
    };

    if (standardJsonInput) {
      const input = standardJsonInput as {
        settings?: {
          evmVersion?: string;
          viaIR?: boolean;
          libraries?: Record<string, Record<string, string>>;
        };
      };
      if (input.settings?.evmVersion)
        settings.evmVersion = input.settings.evmVersion;
      if (input.settings?.viaIR) settings.viaIR = true;
      if (input.settings?.libraries)
        settings.libraries = input.settings.libraries;
    }

    let abi: unknown[] = [];
    try {
      abi = JSON.parse(item.ABI);
    } catch {
      abi = [];
    }

    return {
      chainId,
      address,
      contractName: item.ContractName,
      compiler: settings,
      sources,
      abi,
      constructorArguments:
        item.ConstructorArguments && item.ConstructorArguments.length > 0
          ? (item.ConstructorArguments as `0x${string}`)
          : undefined,
      provider: "etherscan",
      standardJsonInput,
      targetContractPath: targetPath,
    };
  }
}

interface ParsedSource {
  sources: SourceFile[];
  standardJsonInput?: unknown;
  targetPath?: string;
}

/**
 * Parse Etherscan's SourceCode field. Three forms are possible:
 *   1. Single file: plain Solidity source
 *   2. Multi-file: starts with `{{` and ends with `}}`, body is JSON like
 *      `{ "sources": { "path/file.sol": { "content": "..." } } }`
 *   3. Standard JSON: wrapped in triple braces `{{{ ... }}}`
 */
function parseSourceCode(raw: string, fileName?: string): ParsedSource {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{{{") && trimmed.endsWith("}}}")) {
    const body = trimmed.slice(1, -1); // strip outer braces, leave `{{ ... }}`?
    // Actually Etherscan wraps with triple braces: outer two denote "multi-file
    // envelope" and the third means "standard JSON". Strip both layers.
    const inner = trimmed.slice(2, -2);
    try {
      const parsed = JSON.parse(inner ?? body);
      const sources: SourceFile[] = [];
      const srcMap = parsed.sources as
        Record<string, { content: string }> | undefined;
      if (srcMap) {
        for (const [path, src] of Object.entries(srcMap)) {
          sources.push({ path, content: src.content });
        }
      }
      const targetPath = parsed?.settings?.compilationTarget
        ? Object.keys(parsed.settings.compilationTarget)[0]
        : sources[0]?.path;
      return { sources, standardJsonInput: parsed, targetPath };
    } catch {
      // fall through
    }
  }

  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    try {
      const body = trimmed.slice(1, -1);
      const parsed = JSON.parse(body) as {
        sources: Record<string, { content: string }>;
      };
      const sources: SourceFile[] = Object.entries(parsed.sources ?? {}).map(
        ([path, src]) => ({ path, content: src.content }),
      );
      return { sources, targetPath: sources[0]?.path };
    } catch {
      // fall through
    }
  }

  // Single file
  const path = fileName ?? "Contract.sol";
  return { sources: [{ path, content: trimmed }], targetPath: path };
}
