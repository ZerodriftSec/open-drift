/**
 * Parser for solc's `t_*` type identifiers.
 *
 * solc encodes type information in a compact string format like:
 *   t_uint256            -> uint256
 *   t_bool               -> bool
 *   t_address            -> address
 *   t_bytes32            -> bytes32
 *   t_enum(Status)       -> enum Status
 *   t_struct(Config)storage_struct
 *   t_array(t_uint256)storage_dyn_array
 *   t_array(t_uint256)2_storage_array  (fixed length 2)
 *   t_string_storage     -> string
 *   t_bytes_storage      -> bytes (dynamic)
 *   t_mapping(t_address,t_uint256)
 *
 * This module turns those strings into a structured form the decoder can
 * pattern-match on. It does NOT validate — it returns whatever structure
 * it can parse, and the decoder is responsible for deciding whether the
 * result is decodable in the current pipeline.
 */

import type { ValueKind } from "./types";

export interface ParsedType {
  /** Canonical kind. */
  kind: ValueKind;
  /** Original solc typeId. */
  raw: string;
  /** For elementary types: the label, e.g. `uint256`, `bytes32`. */
  label?: string;
  /** For enums: the enum name. */
  enumName?: string;
  /** For structs: the struct name. */
  structName?: string;
  /** For arrays: the element type. */
  element?: ParsedType;
  /** For arrays: true if dynamic length. */
  isDynamicArray?: boolean;
  /** For fixed arrays: the length, if parseable. */
  arrayLength?: number;
  /** For mappings: the key type. */
  keyType?: ParsedType;
  /** For mappings: the value type. */
  valueType?: ParsedType;
  /** For elementary int/uint: bit width. */
  bits?: number;
  /** For elementary bytesN: byte width. */
  byteSize?: number;
}

/**
 * Parse a solc typeId. Handles nested arrays and mappings recursively.
 *
 * Examples:
 *   t_uint256                              -> {kind:"uint", bits:256}
 *   t_int8                                 -> {kind:"int", bits:8}
 *   t_address                              -> {kind:"address"}
 *   t_bool                                 -> {kind:"bool"}
 *   t_bytes32                              -> {kind:"fixedBytes", byteSize:32}
 *   t_enum(Status)                         -> {kind:"enum", enumName:"Status"}
 *   t_struct(Config)storage_storage        -> {kind:"struct", structName:"Config"}
 *   t_array(t_uint256)storage_dyn_array    -> {kind:"array", element:{...}, isDynamicArray:true}
 *   t_array(t_uint256)5_storage_array      -> {kind:"array", element:{...}, arrayLength:5}
 *   t_string_storage                       -> {kind:"string"}
 *   t_bytes_storage                        -> {kind:"bytes"}
 *   t_mapping(t_address,t_uint256)         -> {kind:"mapping", keyType:..., valueType:...}
 *   t_contract(WETH,9)                     -> {kind:"contract", label:"WETH"}
 */
export function parseTypeId(typeId: string): ParsedType {
  return parseTypeIdImpl(typeId);
}

function parseTypeIdImpl(typeId: string): ParsedType {
  if (!typeId) return { kind: "unknown", raw: typeId };

  // Elementary types
  const uintMatch = /^t_uint(\d+)$/.exec(typeId);
  if (uintMatch) {
    return {
      kind: "uint",
      bits: Number(uintMatch[1]),
      label: `uint${uintMatch[1]}`,
      raw: typeId,
    };
  }
  const intMatch = /^t_int(\d+)$/.exec(typeId);
  if (intMatch) {
    return {
      kind: "int",
      bits: Number(intMatch[1]),
      label: `int${intMatch[1]}`,
      raw: typeId,
    };
  }
  if (typeId === "t_address" || typeId === "t_address_payable") {
    return {
      kind: "address",
      label: typeId === "t_address_payable" ? "address payable" : "address",
      raw: typeId,
    };
  }
  if (typeId === "t_bool") return { kind: "bool", label: "bool", raw: typeId };
  if (typeId === "t_string_storage" || typeId === "t_string") {
    return { kind: "string", label: "string", raw: typeId };
  }
  if (typeId === "t_bytes_storage" || typeId === "t_bytes") {
    return { kind: "bytes", label: "bytes", raw: typeId };
  }
  const bytesMatch = /^t_bytes(\d+)$/.exec(typeId);
  if (bytesMatch) {
    const size = Number(bytesMatch[1]);
    return {
      kind: "fixedBytes",
      byteSize: size,
      label: `bytes${size}`,
      raw: typeId,
    };
  }
  const enumMatch = /^t_enum\(([^)]+)\)$/.exec(typeId);
  if (enumMatch) {
    return {
      kind: "enum",
      enumName: enumMatch[1],
      label: `enum ${enumMatch[1]}`,
      raw: typeId,
    };
  }
  const structMatch = /^t_struct\(([^)]+)\)storage_(\w*)$/.exec(typeId);
  if (structMatch) {
    return {
      kind: "struct",
      structName: structMatch[1],
      label: `struct ${structMatch[1]}`,
      raw: typeId,
    };
  }
  const contractMatch = /^t_contract\(([^,)]+)(?:,\d+)?\)\d*$/.exec(typeId);
  if (contractMatch) {
    return { kind: "contract", label: contractMatch[1], raw: typeId };
  }
  const mappingMatch = /^t_mapping\((.+)\)$/.exec(typeId);
  if (mappingMatch) {
    const { key, value } = splitTopLevel(mappingMatch[1]);
    return {
      kind: "mapping",
      keyType: parseTypeIdImpl(key.trim()),
      valueType: parseTypeIdImpl(value.trim()),
      raw: typeId,
    };
  }
  const arrayMatch = /^t_array\((.+)\)(.+)$/.exec(typeId);
  if (arrayMatch) {
    const inner = arrayMatch[1];
    const suffix = arrayMatch[2];
    const element = parseTypeIdImpl(inner);
    // Distinguish dyn_array vs fixed_array by the suffix.
    //   storage_dyn_array  -> dynamic
    //   <N>_storage_array  -> fixed, N elements
    if (suffix === "dyn_storage_array" || suffix === "storage_dyn_array") {
      return { kind: "array", element, isDynamicArray: true, raw: typeId };
    }
    const fixedLenMatch = /^(\d+)_storage_array$/.exec(suffix);
    if (fixedLenMatch) {
      return {
        kind: "array",
        element,
        arrayLength: Number(fixedLenMatch[1]),
        raw: typeId,
      };
    }
    // Unrecognized suffix: assume dynamic.
    return { kind: "array", element, isDynamicArray: true, raw: typeId };
  }

  return { kind: "unknown", raw: typeId };
}

/**
 * Split a string at the first top-level comma (i.e. not inside parens).
 * Used for mapping(K,V) inner content.
 */
function splitTopLevel(s: string): { key: string; value: string } {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      return { key: s.slice(0, i), value: s.slice(i + 1) };
    }
  }
  return { key: s, value: "" };
}

/** Recursively count array dimensions for nested arrays. */
export function arrayDepth(type: ParsedType): number {
  let depth = 0;
  let current: ParsedType | undefined = type;
  while (current?.kind === "array") {
    depth++;
    current = current.element;
  }
  return depth;
}

/**
 * Return the number of bytes occupied by a single slot value of this type
 * (used for packed arrays). 0 means "doesn't fit in one slot" (i.e. needs
 * its own slot or many slots).
 */
export function packedByteSize(type: ParsedType): number {
  switch (type.kind) {
    case "uint":
    case "int":
      return Math.ceil((type.bits ?? 0) / 8) || 0;
    case "bool":
      return 1;
    case "address":
      return 20;
    case "fixedBytes":
      return type.byteSize ?? 0;
    case "enum":
      // Up to 32 members fits in 1 byte, else more. Without AST context we
      // assume 1 byte; callers that know the enum size can override.
      return 1;
    case "contract":
      return 20;
    case "array":
    case "bytes":
    case "mapping":
    case "string":
    case "struct":
    case "unknown":
      return 0; // struct/array/string/bytes/mapping take whole slots
  }
}
