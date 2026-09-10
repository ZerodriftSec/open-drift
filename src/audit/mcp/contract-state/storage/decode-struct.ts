/**
 * Struct decoder.
 *
 * A struct occupies contiguous slots starting at its declared slot. Packed
 * struct fields share a slot just like top-level packed variables. We look
 * up the struct's type in solc's `types` map, which gives us an ordered
 * list of `{ label, type, slot, offset }` members.
 *
 * Recursion: struct members can themselves be structs, arrays, mappings,
 * etc. We delegate to the master decoder for each member.
 */

import type {
  DecodedStruct,
  DecodedValue,
  SlotHex,
  SnapshotOptions,
  StorageVariable,
} from "./types";
import type { LayoutBuild } from "../layout/layout-builder";
import type { SlotReader } from "./decode-context";
import type { SolcStorageLayout } from "./types";
import { decodeValue } from "./decoder";

interface StructMember {
  label: string;
  type: string; // typeId
  slot: string;
  offset: number;
}

interface StructTypeInfo {
  members: StructMember[];
}

function getStructMembers(
  types: SolcStorageLayout["types"],
  typeId: string,
): StructMember[] | undefined {
  const info = types[typeId] as unknown as StructTypeInfo | undefined;
  return info?.members;
}

/**
 * Decode a struct variable. `baseSlot` is the absolute slot where the struct
 * starts (the variable's declared slot).
 */
export async function decodeStruct(
  variable: StorageVariable,
  baseSlot: bigint,
  reader: SlotReader,
  layout: LayoutBuild,
  options: SnapshotOptions,
  depth: number,
): Promise<DecodedStruct> {
  const members = getStructMembers(layout.types, variable.typeId) ?? [];
  const memberVars: StorageVariable[] = members.map((m) => {
    const typeInfo = layout.types[m.type];
    const byteSize = typeInfo ? Number(typeInfo.numberOfBytes) || 0 : 0;
    return {
      name: m.label,
      label: m.label,
      typeId: m.type,
      displayType: typeInfo?.label ?? m.label,
      slot: baseSlot + BigInt(m.slot),
      offset: Number(m.offset) || 0,
      byteSize,
      contractName: variable.contractName,
      kind: "storage",
    };
  });

  const decodedMembers: DecodedValue[] = [];
  for (const mv of memberVars) {
    const memberType = layout.types[mv.typeId];
    // Skip mapping members — they are unsupported and decoded by the main
    // decoder as DecodedUnsupported. We still want to surface them, so we
    // use the decodeValue path rather than skipping outright.
    const decoded = await decodeValue(mv, reader, layout, options, depth + 1);
    if (memberType?.encoding === "mapping" || mv.kind === "mapping") {
      // decodeValue should already mark this unsupported; ensure label is right.
      decoded.displayType =
        decoded.displayType || memberType?.label || mv.displayType;
    }
    decodedMembers.push(decoded);
  }

  return {
    name: variable.name,
    displayType: variable.displayType,
    slot: baseSlot,
    kind: "struct",
    members: decodedMembers,
  };
}

export type { SlotHex };
