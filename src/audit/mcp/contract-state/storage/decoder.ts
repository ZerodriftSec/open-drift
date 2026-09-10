/**
 * Master decoder orchestrator.
 *
 * Takes a StorageVariable, looks at its type, and dispatches to the right
 * sub-decoder (scalar, struct, array, string, bytes). Recursion is bounded
 * by `depth` to guard against pathological layouts.
 *
 * Sub-decoders call back into `decodeValue` for struct members and array
 * elements — the import cycle is intentional and resolves cleanly because
 * the call is dynamic.
 */

import type {
  DecodedScalar,
  DecodedUnsupported,
  DecodedValue,
  SnapshotOptions,
  StorageVariable,
} from "./types";
import type { LayoutBuild } from "../layout/layout-builder";
import type { SlotReader } from "./decode-context";
import { decodeScalar } from "./decode-scalar";
import { decodeStruct } from "./decode-struct";
import { decodeArrayVariable } from "./decode-array";
import {
  decodeBytesVariableAsync,
  decodeStringVariable,
} from "./decode-string-bytes";
import { parseTypeId } from "./type-parser";

const MAX_DEPTH = 16;

/**
 * Decode a single storage variable at its declared slot.
 *
 * @param variable       The variable to decode.
 * @param reader         Slot reader (RPC-backed or in-memory).
 * @param layout         The full layout build (types, enums, etc.).
 * @param options        Snapshot options.
 * @param depth          Current recursion depth; guards against cycles.
 */
export async function decodeValue(
  variable: StorageVariable,
  reader: SlotReader,
  layout: LayoutBuild,
  options: SnapshotOptions,
  depth: number,
): Promise<DecodedValue> {
  if (depth > MAX_DEPTH) {
    return unsupported(variable, variable.slot, "max recursion depth exceeded");
  }

  // Constants and immutables are handled by separate phases (phase 7).
  // They shouldn't reach the decoder in normal flow, but guard anyway.
  if (variable.kind === "constant" || variable.kind === "immutable") {
    return unsupported(
      variable,
      variable.slot,
      `${variable.kind} handled by constant/immutable phase`,
    );
  }

  const parsed = parseTypeId(variable.typeId);

  // Mappings are unsupported (phase 9 degradation).
  if (parsed.kind === "mapping") {
    return unsupported(
      variable,
      variable.slot,
      "Mapping content is not supported in this version",
    );
  }

  switch (parsed.kind) {
    case "uint":
    case "int":
    case "bool":
    case "address":
    case "contract":
    case "fixedBytes":
    case "enum":
      return decodeScalarAt(variable, reader, layout);
    case "struct":
      return await decodeStruct(
        variable,
        variable.slot,
        reader,
        layout,
        options,
        depth,
      );
    case "array":
      return await decodeArrayVariable(
        variable,
        variable.slot,
        reader,
        layout,
        options,
        depth,
      );
    case "string":
      return await decodeStringVariable(variable, variable.slot, reader);
    case "bytes":
      return await decodeBytesVariableAsync(variable, variable.slot, reader);
    case "unknown":
      return unsupported(
        variable,
        variable.slot,
        `unsupported type id: ${variable.typeId}`,
      );
  }
}

async function decodeScalarAt(
  variable: StorageVariable,
  reader: SlotReader,
  layout: LayoutBuild,
): Promise<DecodedScalar> {
  const slotValue = await reader.getSlot(variable.slot);
  const result = decodeScalar(
    slotValue,
    variable.offset,
    variable.byteSize,
    variable.typeId,
    { enums: layout.enums },
  );
  return {
    name: variable.name,
    displayType: variable.displayType,
    slot: variable.slot,
    offset: variable.offset,
    kind: "value",
    raw: result.raw,
    formatted: result.formatted,
  };
}

function unsupported(
  variable: StorageVariable,
  baseSlot: bigint,
  reason: string,
): DecodedUnsupported {
  return {
    name: variable.name,
    displayType: variable.displayType,
    slot: baseSlot,
    kind: "unsupported",
    baseSlot,
    reason,
  };
}

/**
 * Decode all top-level variables in a layout. Constants/immutables are
 * filtered out — they are handled by phase 7 and merged in by the snapshot
 * orchestrator.
 */
export async function decodeAllVariables(
  variables: StorageVariable[],
  reader: SlotReader,
  layout: LayoutBuild,
  options: SnapshotOptions,
): Promise<DecodedValue[]> {
  const out: DecodedValue[] = [];
  for (const v of variables) {
    if (v.kind !== "storage") continue;
    const decoded = await decodeValue(v, reader, layout, options, 0);
    out.push(decoded);
  }
  return out;
}

export { decodeScalar };
