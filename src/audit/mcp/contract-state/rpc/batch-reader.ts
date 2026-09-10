/**
 * JSON-RPC client with batching, retry, dedup, and a small cache.
 *
 * The contract state snapshot pipeline needs to read dozens or hundreds of
 * slots from a single contract at a single block. Batching `eth_getStorageAt`
 * calls into a single HTTP roundtrip is essential for staying under RPC rate
 * limits and keeping latency low.
 *
 * Cache scope: per (chainId, address, blockNumber, slot). The cache is
 * intentionally in-process and per-snapshot — it does not survive restarts
 * because the data on chain can change between blocks.
 */

import type { Address, SlotHex } from "../storage/types";
import { slotToHex } from "../utils/hex";

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: unknown[];
}

export interface RpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface BatchReaderOptions {
  /** Maximum requests in one JSON-RPC batch frame. */
  batchSize?: number;
  /** Maximum concurrent in-flight batches. */
  concurrency?: number;
  /** Per-request retry count for transient errors (429, network). */
  retries?: number;
  /** Base backoff in ms; doubled per retry. */
  baseBackoffMs?: number;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /** Optional fetch override (useful for tests). */
  fetchImpl?: typeof fetch;
}

export interface SlotRead {
  address: Address;
  slot: bigint;
}

const DEFAULTS: Required<Omit<BatchReaderOptions, "fetchImpl">> = {
  batchSize: 64,
  concurrency: 8,
  retries: 3,
  baseBackoffMs: 200,
  requestTimeoutMs: 30000,
};

export class RpcBatchReader {
  private readonly url: string;
  private readonly opts: Required<Omit<BatchReaderOptions, "fetchImpl">>;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: Map<string, `0x${string}`> = new Map();

  constructor(url: string, options: BatchReaderOptions = {}) {
    this.url = url;
    const { fetchImpl, ...rest } = options;
    this.opts = { ...DEFAULTS, ...rest } as Required<
      Omit<BatchReaderOptions, "fetchImpl">
    >;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "global fetch is not available; pass fetchImpl explicitly",
      );
    }
  }

  /**
   * Resolve a block tag ("latest", "finalized", hex/decimal) to a concrete
   * block number. The snapshot pipeline pins all subsequent reads to this
   * block so that array length and array contents can't drift.
   */
  async resolveBlockNumber(tag: string | number): Promise<bigint> {
    if (typeof tag === "number") return BigInt(tag);
    if (
      tag === "latest" ||
      tag === "safe" ||
      tag === "finalized" ||
      tag === "earliest"
    ) {
      const result = await this.sendSingle<`0x${string}`>("eth_blockNumber", [
        tag,
      ]);
      return BigInt(result);
    }
    if (tag.startsWith("0x")) return BigInt(tag);
    return BigInt(tag);
  }

  /** Get a block by number; returns hash + number. */
  async getBlock(
    blockNumber: bigint,
  ): Promise<{ hash: string; number: bigint } | null> {
    const block = await this.sendSingle<{
      hash: string;
      number: `0x${string}`;
    } | null>("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
    if (!block) return null;
    return { hash: block.hash, number: BigInt(block.number) };
  }

  /** Read a single storage slot (uses the batched path under the hood). */
  async getStorageAt(
    address: Address,
    slot: bigint,
    blockNumber: bigint,
  ): Promise<`0x${string}`> {
    const map = await this.getStorageAtBatched(
      [{ address, slot }],
      blockNumber,
    );
    return map.get(`${address.toLowerCase()}@${blockNumber}:${slot}`) ?? "0x";
  }

  /** eth_getCode wrapper. */
  async getCode(address: Address, blockNumber: bigint): Promise<`0x${string}`> {
    return this.sendSingle<`0x${string}`>("eth_getCode", [
      address,
      `0x${blockNumber.toString(16)}`,
    ]);
  }

  /** eth_call wrapper used by public-getter fallbacks for constants/immutables. */
  async ethCall(
    to: Address,
    data: `0x${string}`,
    blockNumber: bigint,
  ): Promise<`0x${string}`> {
    return this.sendSingle<`0x${string}`>("eth_call", [
      { to, data },
      `0x${blockNumber.toString(16)}`,
    ]);
  }

  /**
   * Canonical batched path: caller supplies the blockNumber explicitly.
   * Reads are deduped by (address, slot) and cached so repeated reads from
   * later phases don't re-hit the RPC node.
   */
  async getStorageAtBatched(
    reads: SlotRead[],
    blockNumber: bigint,
  ): Promise<Map<string, `0x${string}`>> {
    const out = new Map<string, `0x${string}`>();
    const queue: SlotRead[] = [];

    for (const r of reads) {
      const key = `${r.address.toLowerCase()}@${blockNumber}:${r.slot}`;
      const cached = this.cache.get(key);
      if (cached !== undefined) {
        out.set(key, cached);
      } else {
        queue.push(r);
      }
    }

    // Dedup within this call
    const uniqueBySlot = new Map<string, SlotRead>();
    for (const r of queue) {
      const k = `${r.address.toLowerCase()}:${r.slot}`;
      if (!uniqueBySlot.has(k)) uniqueBySlot.set(k, r);
    }
    const uniqueReads = [...uniqueBySlot.values()];

    // Fire batches with concurrency control
    const batches: SlotRead[][] = [];
    for (let i = 0; i < uniqueReads.length; i += this.opts.batchSize) {
      batches.push(uniqueReads.slice(i, i + this.opts.batchSize));
    }

    const runBatch = async (batch: SlotRead[]): Promise<void> => {
      const requests: RpcRequest[] = batch.map((p, i) => ({
        jsonrpc: "2.0",
        id: i,
        method: "eth_getStorageAt",
        params: [p.address, slotToHex(p.slot), `0x${blockNumber.toString(16)}`],
      }));
      const responses = await this.sendBatched(requests);
      const byId = new Map(responses.map((r) => [String(r.id), r]));
      batch.forEach((r, i) => {
        const resp = byId.get(String(i));
        if (!resp) throw new Error("missing response in batch");
        if (resp.error) throw new RpcError("eth_getStorageAt", resp.error);
        const value = (resp.result ?? "0x") as `0x${string}`;
        const key = `${r.address.toLowerCase()}@${blockNumber}:${r.slot}`;
        this.cache.set(key, value);
        out.set(key, value);
      });
    };

    await runWithConcurrency(batches, runBatch, this.opts.concurrency);
    return out;
  }

  /** Single-shot RPC call (no batching) for the few non-slot methods. */
  async sendSingle<T>(method: string, params: unknown[]): Promise<T> {
    const id = Math.floor(Math.random() * 2 ** 31);
    const body: RpcRequest = { jsonrpc: "2.0", id, method, params };
    const res = await this.sendRaw(body);
    if (res.error) throw new RpcError(method, res.error);
    return res.result as T;
  }

  private async sendBatched(requests: RpcRequest[]): Promise<RpcResponse[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        return await this.postJson<RpcResponse[]>(requests);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.opts.retries) break;
        const backoff = this.opts.baseBackoffMs * 2 ** attempt;
        await sleep(backoff);
      }
    }
    throw toError(lastErr);
  }

  private async sendRaw(body: RpcRequest): Promise<RpcResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        return await this.postJson<RpcResponse>(body);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.opts.retries) break;
        const backoff = this.opts.baseBackoffMs * 2 ** attempt;
        await sleep(backoff);
      }
    }
    throw toError(lastErr);
  }

  private async postJson<T>(body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.requestTimeoutMs,
    );
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new HttpError(res.status, text);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Clear the cache (mainly for tests). */
  clearCache(): void {
    this.cache.clear();
  }
}

export class RpcError extends Error {
  constructor(
    method: string,
    public readonly detail: { code: number; message: string; data?: unknown },
  ) {
    super(`RPC ${method} failed: ${detail.code} ${detail.message}`);
    this.name = "RpcError";
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof RpcError) {
    return err.detail.code === -32005 || err.detail.code === 429;
  }
  // Network errors are typically TypeError instances from fetch.
  return err instanceof TypeError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

export type { Address, SlotHex };
