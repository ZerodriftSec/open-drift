/**
 * MCP tool definition for `contract_state_snapshot`.
 *
 * The tool takes (chainId, address, block, options) and returns the
 * snapshot as Markdown with a structured content blob.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContractMetadataProvider } from "../metadata/provider";
import { runSnapshot } from "../core/snapshot";
import { DEFAULT_OPTIONS, type DecodedValue } from "../storage/types";
export { contractStateSnapshotToolName } from "../catalog";

export const contractStateSnapshotInputSchema = {
  chainId: z
    .number()
    .int()
    .positive()
    .describe("EVM chain ID (e.g. 1 for Ethereum mainnet)"),
  address: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{40}$/,
      "address must be a 0x-prefixed 40-hex-char string",
    )
    .describe("Contract address"),
  block: z
    .union([z.number().int().nonnegative(), z.string()])
    .default("latest")
    .describe('Block tag ("latest", "finalized", hex string, or block number)'),
  options: z
    .object({
      maxArrayItems: z.number().int().positive().optional(),
      includeConstants: z.boolean().optional(),
      includeImmutables: z.boolean().optional(),
      includeRawSlots: z.boolean().optional(),
      resolveProxy: z.boolean().optional(),
    })
    .optional(),
  rpcUrlOverride: z
    .string()
    .url()
    .optional()
    .describe(
      "Optional per-call RPC URL override for private endpoints or tests",
    ),
};

export type ContractStateSnapshotInput = {
  chainId: number;
  address: `0x${string}`;
  block: string | number;
  options: {
    maxArrayItems: number;
    includeConstants: boolean;
    includeImmutables: boolean;
    includeRawSlots: boolean;
    resolveProxy: boolean;
  };
  rpcUrlOverride?: string;
};

export const contractStateSnapshotDescription = `Produce a complete snapshot of an EVM contract's on-chain storage state at a given block.

The tool:
  - Detects EIP-1967 / UUPS proxies and follows to the implementation for layout.
  - Fetches verified source code (Sourcify first, then Etherscan).
  - Recompiles with solc to obtain the storageLayout.
  - Reads all relevant storage slots via batched eth_getStorageAt.
  - Decodes uint/int/bool/address/bytesN/enum/struct/array/string/bytes/constant/immutable.
  - Marks mappings as unsupported (definition only, no contents).
  - Returns Markdown plus a structured JSON snapshot.

The AI does NOT need to call cast, eth_getStorageAt, or compute slots manually — one call is enough.

Limitations:
  - Mapping contents cannot be enumerated.
  - Diamond Storage and custom assembly layouts are unsupported.
  - Unverified contracts return a metadata-difference / unverified confidence.`;

export interface ToolDeps {
  metadataProvider: ContractMetadataProvider;
}

export function createContractStateSnapshotHandler(deps: ToolDeps) {
  return async (args: unknown): Promise<CallToolResult> => {
    const parsed = z.object(contractStateSnapshotInputSchema).safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid input: ${parsed.error.message}`,
          },
        ],
      };
    }

    const input = parsed.data as ContractStateSnapshotInput;
    try {
      const result = await runSnapshot(
        {
          chainId: input.chainId,
          address: input.address as `0x${string}`,
          block: input.block,
          options: {
            maxArrayItems:
              input.options?.maxArrayItems ?? DEFAULT_OPTIONS.maxArrayItems,
            includeConstants:
              input.options?.includeConstants ??
              DEFAULT_OPTIONS.includeConstants,
            includeImmutables:
              input.options?.includeImmutables ??
              DEFAULT_OPTIONS.includeImmutables,
            includeRawSlots:
              input.options?.includeRawSlots ?? DEFAULT_OPTIONS.includeRawSlots,
            resolveProxy:
              input.options?.resolveProxy ?? DEFAULT_OPTIONS.resolveProxy,
          },
          rpcUrlOverride: input.rpcUrlOverride,
        },
        { metadataProvider: deps.metadataProvider },
      );
      return {
        content: [{ type: "text", text: result.markdown }],
        structuredContent: {
          snapshot: {
            chainId: result.meta.chainId,
            contractAddress: result.meta.contractAddress,
            storageAddress: result.meta.storageAddress,
            blockNumber: result.meta.blockNumber,
            blockHash: result.meta.blockHash,
            proxyType: result.meta.proxy?.type,
            implementationAddress: result.meta.proxy?.implementationAddress,
          },
          source: {
            verified: result.meta.verified,
            compilerVersion: result.meta.compilerVersion,
            layoutConfidence: result.meta.layoutConfidence,
          },
          variables: result.variables.map(jsonSafeDecodedValue),
          rawSlots: result.rawSlots?.map((slot) => ({
            ...slot,
            slot: slot.slot.toString(),
          })),
          warnings: result.meta.warnings,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Snapshot failed: ${(err as Error).message}` },
        ],
      };
    }
  };
}

function jsonSafeDecodedValue(value: DecodedValue): Record<string, unknown> {
  const base = {
    ...value,
    slot: value.slot.toString(),
  } as Record<string, unknown>;

  if ("baseSlot" in value) {
    base.baseSlot = value.baseSlot.toString();
  }

  if (value.kind === "struct") {
    base.members = value.members.map(jsonSafeDecodedValue);
  } else if (value.kind === "array") {
    base.items = value.items.map(jsonSafeDecodedValue);
  }

  return base;
}
