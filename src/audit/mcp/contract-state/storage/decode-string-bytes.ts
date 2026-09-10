/**
 * String + dynamic bytes decoder.
 *
 * Solidity packs short data (≤31 bytes) into a single slot:
 *   - lowest byte = length * 2  (lowest bit is 0)
 *   - higher 31 bytes = the data
 *
 * Long data (≥32 bytes):
 *   - base slot = length * 2 + 1  (lowest bit is 1)
 *   - actual data starts at keccak256(baseSlot), stored in consecutive slots
 *
 * This module decodes both forms and falls back to raw hex if the bytes are
 * not valid UTF-8.
 */

import type {
  DecodedBytes,
  DecodedString,
  SnapshotOptions,
  StorageVariable,
} from "./types";
import type { LayoutBuild } from "../layout/layout-builder";
import type { SlotReader } from "./decode-context";
import {
  bytesToHex,
  hexToBigInt,
  keccakSlot,
  padToSlot,
  tryUtf8,
} from "../utils/hex";

export async function decodeStringVariable(
  variable: StorageVariable,
  baseSlot: bigint,
  reader: SlotReader,
): Promise<DecodedString> {
  const slotValue = await reader.getSlot(baseSlot);
  return decodeShortOrLongString(variable, baseSlot, slotValue, reader);
}

interface ShortLongInfo {
  isLong: boolean;
  length: number;
}

/**
 * Extract the lowest byte of a slot value (Solidity's length/flag byte for
 * short/long string + bytes encoding).
 */
function lowestByte(slotValue: `0x${string}`): number {
  const padded = padToSlot(slotValue);
  return Number.parseInt(padded.slice(-2), 16);
}

function readShortLongFlag(slotValue: `0x${string}`): ShortLongInfo {
  const flag = lowestByte(slotValue);
  const isLong = (flag & 1) === 1;
  const length = isLong ? (Number(flag) - 1) / 2 : Number(flag) / 2;
  return { isLong, length };
}

/**
 * Slice the high-order 31 bytes of a slot value (big-endian display order).
 * Used to read short string/bytes content, which Solidity pads with zeros
 * on the right of the most-significant byte.
 */
function shortDataBytes(slotValue: `0x${string}`, length: number): Uint8Array {
  const padded = padToSlot(slotValue);
  // hex chars [2 .. 2 + 31*2] are the 31 high-order data bytes
  const hex = padded.slice(2, 2 + 31 * 2);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function decodeShortOrLongString(
  variable: StorageVariable,
  baseSlot: bigint,
  slotValue: `0x${string}`,
  reader: SlotReader,
): Promise<DecodedString> {
  const info = readShortLongFlag(slotValue);
  if (!info.isLong) {
    const bytes = shortDataBytes(slotValue, info.length);
    const value = tryUtf8(bytes) ?? "";
    const rawHex = bytesToHex(bytes);
    const decodeWarning =
      tryUtf8(bytes) === null ? ("invalid-utf8" as const) : undefined;
    return Promise.resolve({
      name: variable.name,
      displayType: "string",
      slot: baseSlot,
      kind: "string",
      value,
      bytesLength: info.length,
      decodeWarning,
      rawHex,
    });
  }
  // Long: read the data from keccak256(baseSlot), ceil(length/32) slots.
  return readLongBytes(reader, baseSlot, info.length).then((bytes) => {
    const value = tryUtf8(bytes) ?? "";
    const decodeWarning =
      tryUtf8(bytes) === null ? ("invalid-utf8" as const) : undefined;
    return {
      name: variable.name,
      displayType: "string",
      slot: baseSlot,
      kind: "string",
      value,
      bytesLength: info.length,
      decodeWarning,
      rawHex: bytesToHex(bytes.slice(0, info.length)),
    };
  });
}

export async function decodeBytesVariableAsync(
  variable: StorageVariable,
  baseSlot: bigint,
  reader: SlotReader,
): Promise<DecodedBytes> {
  const slotValue = await reader.getSlot(baseSlot);
  const info = readShortLongFlag(slotValue);
  if (!info.isLong) {
    const bytes = shortDataBytes(slotValue, info.length);
    return {
      name: variable.name,
      displayType: "bytes",
      slot: baseSlot,
      kind: "bytes",
      rawHex: bytesToHex(bytes),
      bytesLength: info.length,
    };
  }
  const bytes = await readLongBytes(reader, baseSlot, info.length);
  return {
    name: variable.name,
    displayType: "bytes",
    slot: baseSlot,
    kind: "bytes",
    rawHex: bytesToHex(bytes.slice(0, info.length)),
    bytesLength: info.length,
  };
}

async function readLongBytes(
  reader: SlotReader,
  baseSlot: bigint,
  length: number,
): Promise<Uint8Array> {
  const dataStart = keccakSlot(baseSlot);
  const numSlots = Math.ceil(length / 32);
  const slots: bigint[] = [];
  for (let i = 0; i < numSlots; i++) {
    slots.push(dataStart + BigInt(i));
  }
  const values = await reader.getMany(slots);
  const out = new Uint8Array(numSlots * 32);
  for (let i = 0; i < numSlots; i++) {
    const v = values.get(slots[i]) ?? "0x";
    const padded = padToSlot(v);
    const hex = padded.slice(2);
    for (let b = 0; b < 32; b++) {
      out[i * 32 + b] = Number.parseInt(hex.slice(b * 2, b * 2 + 2), 16);
    }
  }
  return out;
}

export { hexToBigInt };

// Used by dispatcher; kept here to avoid a circular import.
export type { SnapshotOptions, LayoutBuild };
