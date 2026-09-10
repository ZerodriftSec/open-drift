/**
 * Slot reader abstraction used by all decoders.
 *
 * The decoder walks the storage layout and asks the slot reader for raw
 * 32-byte values. The slot reader transparently batches requests through
 * the RPC batch reader and caches within a snapshot.
 */

import type { Address } from "./types";
import type { RpcBatchReader } from "../rpc/batch-reader";

export interface SlotReader {
  readonly storageAddress: Address;
  readonly blockNumber: bigint;
  getSlot(slot: bigint): Promise<`0x${string}`>;
  getMany(slots: bigint[]): Promise<Map<bigint, `0x${string}`>>;
}

export class RpcSlotReader implements SlotReader {
  constructor(
    private readonly rpc: RpcBatchReader,
    readonly storageAddress: Address,
    readonly blockNumber: bigint,
  ) {}

  async getSlot(slot: bigint): Promise<`0x${string}`> {
    return this.rpc.getStorageAt(this.storageAddress, slot, this.blockNumber);
  }

  async getMany(slots: bigint[]): Promise<Map<bigint, `0x${string}`>> {
    const reads = slots.map((slot) => ({ address: this.storageAddress, slot }));
    const raw = await this.rpc.getStorageAtBatched(reads, this.blockNumber);
    const out = new Map<bigint, `0x${string}`>();
    slots.forEach((slot) => {
      const key = `${this.storageAddress.toLowerCase()}@${this.blockNumber}:${slot}`;
      out.set(slot, raw.get(key) ?? "0x");
    });
    return out;
  }
}

/** A purely in-memory slot reader, useful for tests. */
export class MapSlotReader implements SlotReader {
  readonly storageAddress: Address;
  readonly blockNumber: bigint;
  private readonly map: Map<bigint, `0x${string}`>;

  constructor(
    storage: Map<bigint, `0x${string}`> | Record<string, `0x${string}`>,
    storageAddress: Address = "0x0000000000000000000000000000000000000000",
    blockNumber = 0n,
  ) {
    this.storageAddress = storageAddress;
    this.blockNumber = blockNumber;
    if (storage instanceof Map) {
      this.map = storage;
    } else {
      this.map = new Map();
      for (const [k, v] of Object.entries(storage)) {
        this.map.set(BigInt(k), v);
      }
    }
  }

  async getSlot(slot: bigint): Promise<`0x${string}`> {
    return this.map.get(slot) ?? "0x";
  }

  async getMany(slots: bigint[]): Promise<Map<bigint, `0x${string}`>> {
    const out = new Map<bigint, `0x${string}`>();
    for (const s of slots) out.set(s, this.map.get(s) ?? "0x");
    return out;
  }
}
