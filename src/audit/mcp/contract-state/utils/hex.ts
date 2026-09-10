/**
 * Pure helpers for slot arithmetic and hex/byte manipulation.
 *
 * These are intentionally side-effect free so they can be unit tested
 * independently of any RPC or compiler machinery.
 */

import { keccak256 as viemKeccak256 } from "viem";

const HEX_DIGITS = "0123456789abcdef";

/** Convert a bigint into a 32-byte zero-padded lowercase hex string. */
export function slotToHex(slot: bigint): `0x${string}` {
  if (slot < 0n) {
    throw new Error(`slot must be non-negative, got ${slot}`);
  }
  return `0x${slot.toString(16).padStart(64, "0")}` as `0x${string}`;
}

/** Convert a 0x-prefixed hex string to bigint. */
export function hexToBigInt(hex: `0x${string}`): bigint {
  if (!hex || hex === "0x") return 0n;
  if (!hex.startsWith("0x")) {
    throw new Error(`expected 0x-prefixed hex, got ${hex}`);
  }
  return BigInt(hex);
}

/** Pad arbitrary hex to 32 bytes with leading zeros, lowercase. */
export function padToSlot(hex: `0x${string}`): `0x${string}` {
  const clean = hex.toLowerCase().slice(2);
  return `0x${clean.padStart(64, "0")}` as `0x${string}`;
}

/**
 * Convert a 32-byte slot hex into a LITTLE-ENDIAN byte array.
 *
 * Solidity's storage layout convention numbers bytes from the LOW-order
 * end of the slot. A variable at `offset=N` with `byteSize=M` occupies
 * the bytes at indices `[N, N+M)` in the value's uint256 representation,
 * where index 0 is the least significant byte.
 *
 * Returning the bytes in little-endian order lets callers index directly
 * by offset without re-flipping.
 */
export function slotToBytes(hex: `0x${string}`): Uint8Array {
  const padded = padToSlot(hex);
  const bigEndian = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bigEndian[i] = Number.parseInt(padded.slice(2 + i * 2, 2 + i * 2 + 2), 16);
  }
  // Reverse to little-endian so bytes[offset] is the offset-th low-order byte.
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = bigEndian[31 - i];
  }
  return out;
}

/** Convert a 32-byte LE byte array back into hex (big-endian display). */
export function bytesToSlot(bytes: Uint8Array): `0x${string}` {
  if (bytes.length !== 32) {
    throw new Error(`expected 32 bytes, got ${bytes.length}`);
  }
  let hex = "0x";
  for (let i = 31; i >= 0; i--) {
    const b = bytes[i];
    hex += HEX_DIGITS[(b >> 4) & 0xf] + HEX_DIGITS[b & 0xf];
  }
  return hex as `0x${string}`;
}

/**
 * Read `byteSize` bytes starting at `offset` (low-bytes first, Solidity's
 * packed storage convention) and return as unsigned bigint.
 */
export function readUintLE(
  bytes: Uint8Array,
  offset: number,
  byteSize: number,
): bigint {
  if (offset < 0 || byteSize <= 0 || offset + byteSize > bytes.length) {
    throw new Error(
      `readUintLE out of range: offset=${offset} size=${byteSize} len=${bytes.length}`,
    );
  }
  let value = 0n;
  for (let i = 0; i < byteSize; i++) {
    const byte = bytes[offset + i];
    value |= BigInt(byte) << (8n * BigInt(i));
  }
  return value;
}

/** Interpret `byteSize` bytes as two's-complement signed integer. */
export function readIntLE(
  bytes: Uint8Array,
  offset: number,
  byteSize: number,
): bigint {
  const unsigned = readUintLE(bytes, offset, byteSize);
  const bits = BigInt(byteSize * 8);
  const signBit = 1n << (bits - 1n);
  if (unsigned & signBit) {
    return unsigned - (1n << bits);
  }
  return unsigned;
}

/** Slice `byteSize` bytes from `offset` and return as hex string. */
export function readBytesHex(
  bytes: Uint8Array,
  offset: number,
  byteSize: number,
): `0x${string}` {
  if (offset < 0 || byteSize < 0 || offset + byteSize > bytes.length) {
    throw new Error(
      `readBytesHex out of range: offset=${offset} size=${byteSize} len=${bytes.length}`,
    );
  }
  let hex = "0x";
  for (let i = 0; i < byteSize; i++) {
    const b = bytes[offset + i];
    hex += HEX_DIGITS[(b >> 4) & 0xf] + HEX_DIGITS[b & 0xf];
  }
  return hex as `0x${string}`;
}

/**
 * Compute keccak256 of a 32-byte slot value, returned as bigint.
 * Used for dynamic array data and mapping value addresses.
 */
export function keccakSlot(slot: bigint): bigint {
  const slotHex = slotToHex(slot);
  const hash = viemKeccak256(slotHex);
  return hexToBigInt(hash);
}

/** keccak256 of an arbitrary hex string, returned as bigint. */
export function keccakHex(hex: `0x${string}`): bigint {
  const hash = viemKeccak256(hex);
  return hexToBigInt(hash);
}

/** Concatenate two byte arrays. */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Convert a bigint to a 32-byte big-endian byte array. */
export function bigIntToBytes32(value: bigint): Uint8Array {
  if (value < 0n) throw new Error(`expected non-negative, got ${value}`);
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Convert a UTF-8 string to a hex string. */
export function utf8ToHex(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s);
  let hex = "0x";
  for (const b of bytes) {
    hex += HEX_DIGITS[(b >> 4) & 0xf] + HEX_DIGITS[b & 0xf];
  }
  return hex as `0x${string}`;
}

/** Try to decode bytes as UTF-8; return null on failure (not crash). */
export function tryUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Convert a byte array to a 0x-prefixed lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x";
  for (const b of bytes) {
    hex += HEX_DIGITS[(b >> 4) & 0xf] + HEX_DIGITS[b & 0xf];
  }
  return hex as `0x${string}`;
}
