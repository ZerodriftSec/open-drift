/**
 * Scalar value decoder.
 *
 * Handles elementary types packed into one or more slots: uint/int N, bool,
 * address, bytes1..32, enum, and contract references. The caller passes in
 * the raw 32-byte slot value and the variable's offset/byteSize and we cut
 * out the relevant bytes.
 *
 * Two's complement handling for signed ints: read `byteSize` bytes as
 * unsigned, then sign-extend if the top bit is set.
 */

import type { DecodedScalar, EnumDefinition } from "./types";
import { readBytesHex, readIntLE, readUintLE, slotToBytes } from "../utils/hex";
import { parseTypeId } from "./type-parser";

export interface ScalarDecodeContext {
  enums: EnumDefinition[];
}

/**
 * Decode a scalar value at `offset`/`byteSize` within `slotValue`.
 *
 * @param slotValue  32-byte hex value from eth_getStorageAt
 * @param offset     byte offset within slot (Solidity's low-bytes-first)
 * @param byteSize   number of bytes the variable occupies
 * @param typeId     solc typeId (e.g. `t_uint256`, `t_enum(Status)`)
 */
export function decodeScalar(
  slotValue: `0x${string}`,
  offset: number,
  byteSize: number,
  typeId: string,
  ctx: ScalarDecodeContext,
): Pick<DecodedScalar, "raw" | "formatted"> {
  const parsed = parseTypeId(typeId);

  switch (parsed.kind) {
    case "uint": {
      const bytes = slotToBytes(slotValue);
      const value = readUintLE(bytes, offset, byteSize);
      return { raw: value.toString(10) };
    }
    case "int": {
      const bytes = slotToBytes(slotValue);
      const value = readIntLE(bytes, offset, byteSize);
      return { raw: value.toString(10) };
    }
    case "bool": {
      const bytes = slotToBytes(slotValue);
      const value = readUintLE(bytes, offset, byteSize);
      return { raw: value === 0n ? "false" : "true" };
    }
    case "address": {
      const bytes = slotToBytes(slotValue);
      const hex = readBytesHex(bytes, offset, 20);
      return { raw: hex, formatted: hex };
    }
    case "contract": {
      const bytes = slotToBytes(slotValue);
      const hex = readBytesHex(bytes, offset, 20);
      return { raw: hex, formatted: hex };
    }
    case "fixedBytes": {
      const bytes = slotToBytes(slotValue);
      const hex = readBytesHex(bytes, offset, byteSize);
      return { raw: hex };
    }
    case "enum": {
      const bytes = slotToBytes(slotValue);
      const value = readUintLE(bytes, offset, byteSize);
      const name = parsed.enumName
        ? ctx.enums.find((e) => e.name === parsed.enumName)?.members[
            Number(value)
          ]
        : undefined;
      if (name) {
        return { raw: value.toString(10), formatted: `${name} (${value})` };
      }
      return {
        raw: value.toString(10),
        formatted: `#${value} (enum definition missing)`,
      };
    }
    case "array":
    case "bytes":
    case "mapping":
    case "string":
    case "struct":
    case "unknown":
      // Not actually a scalar; caller should dispatch elsewhere.
      return { raw: "" };
  }
}
