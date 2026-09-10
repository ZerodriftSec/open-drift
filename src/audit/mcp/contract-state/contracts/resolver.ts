/**
 * Contract resolver: fetch on-chain bytecode and (optionally) follow a proxy
 * to its implementation.
 */

import type { Address, ProxyInfo } from "../storage/types";
import type { RpcBatchReader } from "../rpc/batch-reader";
import {
  detectProxy,
  getEip1167Implementation,
  isEip1167Clone,
} from "./proxy-detector";

export interface ResolvedContract {
  /** The address whose bytecode we are inspecting. */
  address: Address;
  bytecode: `0x${string}`;
  bytecodeSize: number;
  /** True if the on-chain bytecode is empty (no contract deployed here). */
  isEmpty: boolean;
  /** Proxy info; `type === "none"` if not a proxy. */
  proxy: ProxyInfo;
}

/**
 * Resolve the user-supplied address: fetch its bytecode and detect proxy.
 *
 * Note: this function does NOT recurse into the implementation. The caller
 * is expected to do that if proxy.type !== "none". We split the work so the
 * snapshot pipeline can decide separately which address to read storage from
 * (always the proxy) and which to fetch source/layout for (the implementation).
 */
export async function resolveContract(
  rpc: RpcBatchReader,
  address: Address,
  blockNumber: bigint,
  resolveProxy: boolean,
): Promise<ResolvedContract> {
  const bytecode = await rpc.getCode(address, blockNumber);
  const bytecodeSize = bytecode === "0x" ? 0 : (bytecode.length - 2) / 2;
  const isEmpty = bytecodeSize === 0;

  let proxy: ProxyInfo;
  if (!isEmpty && resolveProxy) {
    proxy = await detectProxy(rpc, address, blockNumber);
    if (proxy.type === "none" && isEip1167Clone(bytecode)) {
      const impl = getEip1167Implementation(bytecode);
      if (impl) {
        proxy = { type: "beacon", proxyAddress: address, beaconAddress: impl };
      }
    }
  } else {
    proxy = { type: "none", proxyAddress: address };
  }

  return { address, bytecode, bytecodeSize, isEmpty, proxy };
}
