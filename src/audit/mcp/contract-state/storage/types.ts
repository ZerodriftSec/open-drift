/**
 * Core type definitions for the contract state snapshot pipeline.
 *
 * These types describe a normalized view of a contract's storage layout and
 * the decoded runtime values read from the chain. The layout is derived from
 * solc's `storageLayout` output and the values come from `eth_getStorageAt`.
 */

export type Address = `0x${string}`;

/** A 32-byte storage slot, lowercase hex, 0x-prefixed, zero-padded to 64 nibbles. */
export type SlotHex = `0x${string}`;

export type DeclarationKind = "storage" | "constant" | "immutable" | "mapping";

/** Categories of value types that the decoder knows how to handle. */
export type ValueKind =
  | "uint"
  | "int"
  | "address"
  | "bool"
  | "bytes"
  | "fixedBytes"
  | "enum"
  | "string"
  | "struct"
  | "array"
  | "contract"
  | "mapping"
  | "unknown";

/** Normalized description of a single storage variable's location. */
export interface StorageVariable {
  name: string;
  label: string;
  /** solc storageLayout typeId (t_uint256, t_struct(...) etc.) */
  typeId: string;
  /** Human-readable type for display, e.g. `uint256`, `address[]`, `Config`. */
  displayType: string;
  /** Absolute slot offset from the start of the contract's storage. */
  slot: bigint;
  /** Byte offset within the slot (0 = least significant byte). */
  offset: number;
  /** Number of bytes occupied in the slot. */
  byteSize: number;
  /** Contract that declares this variable (for inheritance chains). */
  contractName: string;
  kind: DeclarationKind;
}

/** A normalized enum definition extracted from the AST. */
export interface EnumDefinition {
  name: string;
  members: string[];
}

/** Result kind produced by the decoder. */
export type DecodedKind =
  | "value"
  | "struct"
  | "array"
  | "string"
  | "bytes"
  | "constant"
  | "immutable"
  | "unsupported";

export interface DecodedValueBase {
  name: string;
  displayType: string;
  slot: bigint;
  offset?: number;
  kind: DecodedKind;
}

export interface DecodedScalar extends DecodedValueBase {
  kind: "value";
  /** Solidity literal representation, e.g. `"123"`, `"true"`, `"0x..."`. */
  raw: string;
  /** Optional friendly representation (enum name, formatted address, etc.). */
  formatted?: string;
}

export interface DecodedStruct extends DecodedValueBase {
  kind: "struct";
  members: DecodedValue[];
}

export interface DecodedArray extends DecodedValueBase {
  kind: "array";
  elementType: string;
  length: number;
  returnedItems: number;
  truncated: boolean;
  items: DecodedValue[];
}

export interface DecodedString extends DecodedValueBase {
  kind: "string";
  value: string;
  bytesLength: number;
  decodeWarning?: "invalid-utf8";
  rawHex: string;
}

export interface DecodedBytes extends DecodedValueBase {
  kind: "bytes";
  rawHex: string;
  bytesLength: number;
}

export interface DecodedConstant extends DecodedValueBase {
  kind: "constant";
  raw: string;
  formatted?: string;
  source: "source-ast" | "public-getter";
}

export interface DecodedImmutable extends DecodedValueBase {
  kind: "immutable";
  raw: string;
  formatted?: string;
  source: "public-getter" | "runtime-bytecode" | "immutable-references";
}

export interface DecodedUnsupported extends DecodedValueBase {
  kind: "unsupported";
  baseSlot: bigint;
  reason: string;
}

export type DecodedValue =
  | DecodedScalar
  | DecodedStruct
  | DecodedArray
  | DecodedString
  | DecodedBytes
  | DecodedConstant
  | DecodedImmutable
  | DecodedUnsupported;

export interface LayoutVariable {
  label: string;
  type: string;
  slot: string;
  offset: number;
  contract: string;
  astId?: number;
}

export interface LayoutType {
  id: string;
  encoding: string;
  label: string;
  numberOfBytes: string;
  key?: string;
  value?: string;
  base?: string;
  members?: Array<{ label: string; type: string }>;
}

export interface SolcStorageLayout {
  storage: LayoutVariable[];
  types: Record<string, LayoutType>;
}

export type LayoutConfidence =
  "exact" | "metadata-difference" | "partial-match" | "unverified";

export interface BytecodeComparison {
  confidence: LayoutConfidence;
  onChainLength: number;
  compiledLength: number;
  reasons: string[];
}

/** Options controlling the snapshot. */
export interface SnapshotOptions {
  maxArrayItems: number;
  includeConstants: boolean;
  includeImmutables: boolean;
  includeRawSlots: boolean;
  resolveProxy: boolean;
  arraySlice?: "head" | "tail" | "head-tail";
}

export const DEFAULT_OPTIONS: SnapshotOptions = {
  maxArrayItems: 200,
  includeConstants: true,
  includeImmutables: true,
  includeRawSlots: false,
  resolveProxy: true,
};

export type ProxyType =
  "transparent" | "uups" | "beacon" | "diamond" | "unknown-proxy" | "none";

export interface ProxyInfo {
  type: ProxyType;
  proxyAddress: Address;
  implementationAddress?: Address;
  beaconAddress?: Address;
  adminAddress?: Address;
}

export interface SnapshotMeta {
  chainId: number;
  contractAddress: Address;
  storageAddress: Address;
  blockNumber: number;
  blockHash?: string;
  proxy?: ProxyInfo;
  verified: boolean;
  compilerVersion?: string;
  layoutConfidence: LayoutConfidence;
  warnings: string[];
}

export interface SnapshotResult {
  meta: SnapshotMeta;
  variables: DecodedValue[];
  rawSlots?: Array<{ slot: bigint; value: `0x${string}` }>;
  markdown: string;
}
