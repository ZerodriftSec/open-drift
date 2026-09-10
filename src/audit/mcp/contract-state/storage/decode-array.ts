/**
 * Array decoder (fixed / dynamic / packed / nested).
 *
 * Slot math:
 *
 * Dynamic array:
 *   length        = read baseSlot as uint256
 *   dataStartSlot = keccak256(baseSlot)
 *   element i     = dataStartSlot + (i * slotsPerElement) [+ offset for packed]
 *
 * Fixed array:
 *   element i     = baseSlot + (i * slotsPerElement) [+ offset for packed]
 *
 * Packed arrays (element byte size < 32):
 *   elementsPerSlot = floor(32 / elementByteSize)
 *   element i       = dataStartSlot + floor(i / elementsPerSlot)
 *   offset within   = (i % elementsPerSlot) * elementByteSize
 *
 * Struct elements:
 *   slotsPerElement = ceil(struct.numberOfBytes / 32), looked up via the
 *   struct's typeId in `layout.types`.
 *
 * Truncation:
 *   If length > maxArrayItems, only the first N items are decoded. The
 *   `truncated` flag and `returnedItems` are surfaced to the caller.
 */

import type {
  DecodedArray,
  DecodedValue,
  SnapshotOptions,
  StorageVariable,
} from "./types";
import type { LayoutBuild } from "../layout/layout-builder";
import type { SlotReader } from "./decode-context";
import { decodeValue } from "./decoder";
import { keccakSlot } from "../utils";
import { packedByteSize, parseTypeId } from "./type-parser";

interface ArrayPlan {
  isDynamic: boolean;
  length: number;
  slotsPerElement: number;
  elementByteSize: number;
  elementsPerSlot: number;
  isPacked: boolean;
  dataStartSlot: bigint;
  truncated: boolean;
  returnedItems: number;
}

function planArray(
  parsed: ReturnType<typeof parseTypeId>,
  layout: LayoutBuild,
  options: SnapshotOptions,
  declaredSlot: bigint,
  lengthFromSlot: bigint | undefined,
): ArrayPlan {
  const isDynamic = parsed.isDynamicArray === true;
  const element = parsed.element!;
  const elementBytes = computeElementByteSize(element, layout);
  const isPacked = elementBytes > 0 && elementBytes < 32;
  const slotsPerElement = isPacked
    ? 1
    : Math.max(1, Math.ceil(elementBytes / 32)) || 1;
  const elementsPerSlot = isPacked ? Math.floor(32 / elementBytes) : 1;

  const length = isDynamic
    ? Number(lengthFromSlot ?? 0n)
    : (parsed.arrayLength ?? 0);

  let returnedItems = length;
  let truncated = false;
  if (length > options.maxArrayItems) {
    returnedItems = options.maxArrayItems;
    truncated = true;
  }

  const dataStartSlot = isDynamic ? keccakSlot(declaredSlot) : declaredSlot;

  return {
    isDynamic,
    length,
    slotsPerElement,
    elementByteSize: elementBytes,
    elementsPerSlot,
    isPacked,
    dataStartSlot,
    truncated,
    returnedItems,
  };
}

function computeElementByteSize(
  element: ReturnType<typeof parseTypeId>,
  layout: LayoutBuild,
): number {
  if (element.kind === "struct" && element.raw) {
    const info = layout.types[element.raw];
    if (info?.numberOfBytes) return Number(info.numberOfBytes);
  }
  if (element.kind === "array" && element.raw) {
    // For nested arrays, each element occupies its full slot count.
    const info = layout.types[element.raw];
    if (info?.numberOfBytes) return Number(info.numberOfBytes);
  }
  if (element.kind === "string" || element.kind === "bytes") {
    // Dynamic element: each takes one slot (a pointer).
    return 32;
  }
  return packedByteSize(element) * 1 || 32;
}

export async function decodeArrayVariable(
  variable: StorageVariable,
  baseSlot: bigint,
  reader: SlotReader,
  layout: LayoutBuild,
  options: SnapshotOptions,
  depth: number,
): Promise<DecodedArray> {
  const parsed = parseTypeId(variable.typeId);
  if (parsed.kind !== "array" || !parsed.element) {
    throw new Error(
      `decodeArrayVariable called on non-array: ${variable.typeId}`,
    );
  }

  let lengthFromSlot: bigint | undefined;
  if (parsed.isDynamicArray) {
    const slotValue = await reader.getSlot(baseSlot);
    lengthFromSlot = BigInt(slotValue === "0x" ? "0x0" : slotValue);
  }

  const plan = planArray(parsed, layout, options, baseSlot, lengthFromSlot);

  const items: DecodedValue[] = [];
  // Build synthetic StorageVariables for each element we plan to decode.
  for (let i = 0; i < plan.returnedItems; i++) {
    let elementSlot: bigint;
    let elementOffset: number;
    if (plan.isPacked) {
      const slotIndex = Math.floor(i / plan.elementsPerSlot);
      const slotOffset = (i % plan.elementsPerSlot) * plan.elementByteSize;
      elementSlot =
        plan.dataStartSlot + BigInt(slotIndex) * BigInt(plan.slotsPerElement);
      elementOffset = slotOffset;
    } else {
      elementSlot =
        plan.dataStartSlot + BigInt(i) * BigInt(plan.slotsPerElement);
      elementOffset = 0;
    }

    const elementType = parsed.element!;
    const elementTypeId = elementType.raw;
    const typeInfo = layout.types[elementTypeId];
    const byteSize = typeInfo
      ? Number(typeInfo.numberOfBytes) || plan.elementByteSize
      : plan.elementByteSize;

    const syntheticVar: StorageVariable = {
      name: `[${i}]`,
      label: `[${i}]`,
      typeId: elementTypeId,
      displayType: typeInfo?.label ?? elementType.label ?? "unknown",
      slot: elementSlot,
      offset: elementOffset,
      byteSize,
      contractName: variable.contractName,
      kind: "storage",
    };

    const decoded = await decodeValue(
      syntheticVar,
      reader,
      layout,
      options,
      depth + 1,
    );
    items.push(decoded);
  }

  return {
    name: variable.name,
    displayType: variable.displayType,
    slot: baseSlot,
    kind: "array",
    elementType:
      parsed.element?.label ??
      layout.types[parsed.element?.raw ?? ""]?.label ??
      "unknown",
    length: plan.length,
    returnedItems: plan.returnedItems,
    truncated: plan.truncated,
    items,
  };
}
