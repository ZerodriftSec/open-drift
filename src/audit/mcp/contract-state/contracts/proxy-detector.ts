/**
 * EIP-1967 / UUPS / beacon proxy detection.
 *
 * The implementation slot, admin slot, and beacon slot are well-known
 * keccak256 hashes that are extremely unlikely to collide with real storage.
 * Reading them tells us (a) whether the contract is a proxy and (b) where
 * the implementation lives.
 *
 * References:
 *   - EIP-1967: Standard Proxy Storage Slots
 *   - ERC-1822: Universal Upgradeable Proxy Standard (UUPS)
 */

import type { Address, ProxyInfo, ProxyType } from "../storage/types";
import type { RpcBatchReader } from "../rpc/batch-reader";
import { hexToBigInt } from "../utils/hex";

// keccak256("eip1967.proxy.implementation") - 1
export const EIP1967_IMPL_SLOT =
  0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbcn;
// keccak256("eip1967.proxy.beacon") - 1
export const EIP1967_BEACON_SLOT =
  0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50n;
// keccak256("eip1967.proxy.admin") - 1
export const EIP1967_ADMIN_SLOT =
  0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103n;
/** EIP-1822 proxiable slot; for UUPS, this slot stores a UUID-like value. */
export const ERC1822_PROXIABLE_SLOT =
  0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7n;

function isZeroAddress(addr: `0x${string}`): boolean {
  const v = hexToBigInt(addr);
  return v === 0n;
}

function toAddress(slot: `0x${string}`): Address | undefined {
  if (isZeroAddress(slot)) return undefined;
  // Address is in the last 20 bytes of the slot.
  const padded = slot.toLowerCase().slice(2).padStart(64, "0");
  const addr = `0x${padded.slice(-40)}` as Address;
  return addr;
}

/**
 * Detect whether the contract at `address` is a proxy. If yes, classify the
 * proxy type and resolve the implementation address.
 *
 * Strategy:
 *   1. Read all three EIP-1967 slots + ERC-1822 proxiable slot.
 *   2. If implementation slot is set → Transparent or UUPS (we cannot
 *      distinguish without ABI; we mark "transparent" if admin slot is also
 *      set, otherwise "uups").
 *   3. If beacon slot is set → beacon proxy; implementation resolved via
 *      beacon contract's `implementation()` call (delegated to caller).
 */
export async function detectProxy(
  rpc: RpcBatchReader,
  address: Address,
  blockNumber: bigint,
): Promise<ProxyInfo> {
  const slots = [
    EIP1967_IMPL_SLOT,
    EIP1967_ADMIN_SLOT,
    EIP1967_BEACON_SLOT,
    ERC1822_PROXIABLE_SLOT,
  ];
  const map = await rpc.getStorageAtBatched(
    slots.map((slot) => ({ address, slot })),
    blockNumber,
  );
  const read = (slot: bigint): `0x${string}` =>
    map.get(`${address.toLowerCase()}@${blockNumber}:${slot}`) ?? "0x";

  const implSlot = read(EIP1967_IMPL_SLOT);
  const adminSlot = read(EIP1967_ADMIN_SLOT);
  const beaconSlot = read(EIP1967_BEACON_SLOT);
  // const proxiableSlot = read(ERC1822_PROXIABLE_SLOT); // reserved for future disambiguation

  const implAddress = toAddress(implSlot);
  const adminAddress = toAddress(adminSlot);
  const beaconAddress = toAddress(beaconSlot);

  if (implAddress) {
    const type: ProxyType = adminAddress ? "transparent" : "uups";
    return {
      type,
      proxyAddress: address,
      implementationAddress: implAddress,
      adminAddress,
    };
  }

  if (beaconAddress) {
    return {
      type: "beacon",
      proxyAddress: address,
      beaconAddress,
    };
  }

  return {
    type: "none",
    proxyAddress: address,
  };
}

/**
 * Resolve a beacon proxy's implementation by calling
 * `implementation()` on the beacon contract (per EIP-1967).
 */
export async function resolveBeaconImplementation(
  rpc: RpcBatchReader,
  beaconAddress: Address,
  blockNumber: bigint,
): Promise<Address | undefined> {
  // function implementation() view returns (address)
  // selector: keccak256("implementation()")[:4] = 0x5c60da1b
  try {
    const result = await rpc.ethCall(beaconAddress, "0x5c60da1b", blockNumber);
    const hex = result.toLowerCase();
    if (
      hex === "0x" ||
      hex ===
        "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      return undefined;
    }
    const padded = hex.slice(2).padStart(64, "0");
    return `0x${padded.slice(-40)}` as Address;
  } catch {
    return undefined;
  }
}

/**
 * Return the implementation address for a proxy, resolving beacons if
 * needed. For Transparent/UUPS proxies the implementation is already
 * stored in the proxy slot.
 */
export async function getImplementationAddress(
  rpc: RpcBatchReader,
  proxy: ProxyInfo,
  blockNumber: bigint,
): Promise<Address | undefined> {
  if (proxy.implementationAddress) return proxy.implementationAddress;
  if (proxy.beaconAddress) {
    return resolveBeaconImplementation(rpc, proxy.beaconAddress, blockNumber);
  }
  return undefined;
}

/** Heuristic: does the bytecode look like a minimal proxy (EIP-1167)? */
export function isEip1167Clone(bytecode: `0x${string}`): boolean {
  const hex = bytecode.toLowerCase();
  // EIP-1167 minimal proxy runtime code template:
  //   363d3d373d3d3d363d73<address>5af43d82803e903d91602b57fd5bf3
  return (
    hex.startsWith("0x363d3d373d3d3d363d73") &&
    hex.endsWith("5af43d82803e903d91602b57fd5bf3")
  );
}

/** Extract the implementation address from an EIP-1167 clone's bytecode. */
export function getEip1167Implementation(
  bytecode: `0x${string}`,
): Address | undefined {
  if (!isEip1167Clone(bytecode)) return undefined;
  const hex = bytecode.slice(2);
  // Bytes 10-30 (chars 20-60) hold the 20-byte address.
  return `0x${hex.slice(20, 60)}` as Address;
}
