/**
 * Snapshot orchestrator.
 *
 * End-to-end pipeline that ties together every phase:
 *
 *   1. Resolve chain config + RPC reader
 *   2. Pin the block number
 *   3. Resolve on-chain contract (bytecode + proxy detection)
 *   4. If proxy, resolve implementation
 *   5. Fetch contract metadata for the layout address (proxy or impl)
 *   6. Compile with solc to get storageLayout + AST
 *   7. Compare bytecode to compute layout confidence
 *   8. Build normalized StorageVariable[] + enum/constant/immutable tables
 *   9. Plan and execute base slot reads
 *  10. Walk the layout and decode each top-level variable
 *  11. Resolve constants + immutables via AST / getters
 *  12. Render Markdown
 *
 * Storage vs Layout: when the contract is a proxy, storage is read from the
 * proxy address (where the user's data lives) but the layout / constants /
 * immutables / ABI come from the implementation.
 */

import { getChain } from "../chains/registry";
import { RpcBatchReader } from "../rpc/batch-reader";
import { resolveContract } from "../contracts/resolver";
import { getImplementationAddress } from "../contracts/proxy-detector";
import { compileContract, type CompiledContract } from "../layout/compiler";
import { buildLayout } from "../layout/layout-builder";
import { compareBytecode } from "../layout/bytecode-comparator";
import { decodeAllVariables } from "../storage/decoder";
import { RpcSlotReader } from "../storage/decode-context";
import {
  resolveConstants,
  resolveImmutables,
} from "../storage/constant-immutable";
import { renderMarkdown } from "../renderer/markdown";
import {
  DEFAULT_OPTIONS,
  type Address,
  type DecodedValue,
  type ProxyInfo,
  type SnapshotMeta,
  type SnapshotOptions,
  type SnapshotResult,
} from "../storage/types";
import type { ContractMetadataProvider } from "../metadata/provider";

export interface SnapshotInput {
  chainId: number;
  address: Address;
  block?: string | number;
  options?: Partial<SnapshotOptions>;
  /** Override RPC for tests / private endpoints. */
  rpcUrlOverride?: string;
}

export interface SnapshotDeps {
  metadataProvider: ContractMetadataProvider;
  rpc?: RpcBatchReader;
}

export async function runSnapshot(
  input: SnapshotInput,
  deps: SnapshotDeps,
): Promise<SnapshotResult> {
  const options: SnapshotOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const chain = getChain(input.chainId, input.rpcUrlOverride);
  const rpc = deps.rpc ?? new RpcBatchReader(chain.rpcUrl);

  // 1. Pin block
  const blockNumber = await rpc.resolveBlockNumber(input.block ?? "latest");
  const block = await rpc.getBlock(blockNumber).catch(() => null);

  // 2. Resolve contract
  const contract = await resolveContract(
    rpc,
    input.address,
    blockNumber,
    options.resolveProxy,
  );
  if (contract.isEmpty) {
    throw new Error(
      `No contract deployed at ${input.address} on chain ${input.chainId}`,
    );
  }

  let proxy: ProxyInfo = contract.proxy;
  let layoutAddress = input.address;

  if (options.resolveProxy && proxy.type !== "none") {
    const impl = await getImplementationAddress(rpc, proxy, blockNumber);
    if (impl) {
      proxy = { ...proxy, implementationAddress: impl };
      layoutAddress = impl;
    }
  }

  // 3. Fetch metadata for layout address
  const metadata = await deps.metadataProvider.getContractMetadata(
    input.chainId,
    layoutAddress,
  );
  if (!metadata) {
    return unverifiedSnapshot(
      input,
      options,
      blockNumber,
      block?.hash,
      proxy,
      contract.bytecodeSize,
    );
  }

  // 4. Compile
  let compiled: CompiledContract;
  try {
    compiled = await compileContract(metadata);
  } catch (err) {
    return unverifiedSnapshot(
      input,
      options,
      blockNumber,
      block?.hash,
      proxy,
      contract.bytecodeSize,
      `Compilation failed: ${(err as Error).message}`,
    );
  }

  // 5. Confidence check
  const layoutBytecode = (
    await rpc.getCode(layoutAddress, blockNumber)
  ).toLowerCase() as `0x${string}`;
  const comparison = compareBytecode(layoutBytecode, compiled.deployedBytecode);

  // 6. Build normalized layout
  const layout = buildLayout(compiled);

  // 7. Decode storage variables (read from proxy address — where data lives)
  const storageAddress = input.address;
  const slotReader = new RpcSlotReader(rpc, storageAddress, blockNumber);
  const decodedStorage: DecodedValue[] = await decodeAllVariables(
    layout.variables,
    slotReader,
    layout,
    options,
  );

  // 8. Constants + immutables (read from layout address — they live in code)
  const constants = options.includeConstants
    ? await resolveConstants(
        layout.constants,
        compiled,
        rpc,
        storageAddress,
        blockNumber,
      ).catch(() => [])
    : [];
  const immutables = options.includeImmutables
    ? await resolveImmutables(
        layout.immutables,
        compiled,
        layoutBytecode,
        rpc,
        storageAddress,
        blockNumber,
      ).catch(() => [])
    : [];

  const warnings: string[] = [];
  if (
    comparison.confidence === "partial-match" ||
    comparison.confidence === "unverified"
  ) {
    warnings.push(
      `Layout confidence: ${comparison.confidence} — ${comparison.reasons.join("; ")}`,
    );
  }

  const meta: SnapshotMeta = {
    chainId: input.chainId,
    contractAddress: input.address,
    storageAddress,
    blockNumber: Number(blockNumber),
    blockHash: block?.hash,
    proxy: proxy.type === "none" ? undefined : proxy,
    verified: true,
    compilerVersion: metadata.compiler.version,
    layoutConfidence: comparison.confidence,
    warnings,
  };

  const variables: DecodedValue[] = [
    ...decodedStorage,
    ...constants,
    ...immutables,
  ];

  const result: SnapshotResult = {
    meta,
    variables,
    markdown: "",
  };
  if (options.includeRawSlots) {
    result.rawSlots = await collectRawSlots(layout.variables, slotReader);
  }
  result.markdown = renderMarkdown(result);
  return result;
}

async function collectRawSlots(
  variables: { slot: bigint; kind: string }[],
  reader: RpcSlotReader,
): Promise<Array<{ slot: bigint; value: `0x${string}` }>> {
  const seen = new Set<string>();
  const slots: bigint[] = [];
  for (const v of variables) {
    if (v.kind === "constant" || v.kind === "mapping" || v.kind === "immutable")
      continue;
    const key = v.slot.toString();
    if (!seen.has(key)) {
      seen.add(key);
      slots.push(v.slot);
    }
  }
  const map = await reader.getMany(slots);
  return slots.map((slot) => ({ slot, value: map.get(slot) ?? "0x" }));
}

function unverifiedSnapshot(
  input: SnapshotInput,
  options: SnapshotOptions,
  blockNumber: bigint,
  blockHash: string | undefined,
  proxy: ProxyInfo,
  bytecodeSize: number,
  errorMessage?: string,
): SnapshotResult {
  const meta: SnapshotMeta = {
    chainId: input.chainId,
    contractAddress: input.address,
    storageAddress: input.address,
    blockNumber: Number(blockNumber),
    blockHash,
    proxy: proxy.type === "none" ? undefined : proxy,
    verified: false,
    layoutConfidence: "unverified",
    warnings: [
      errorMessage ??
        "Contract source code is not verified on any configured explorer.",
    ],
  };
  const result: SnapshotResult = {
    meta,
    variables: [],
    markdown: "",
  };
  result.markdown = renderMarkdown(result);
  void options;
  void bytecodeSize;
  return result;
}
