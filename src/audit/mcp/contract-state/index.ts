/**
 * Public API for the contract-state MCP.
 */

export {
  contractStateMcpServerName,
  createContractStateMcpServer,
  buildDefaultMetadataProvider,
  getContractStateMcpUrl,
} from "./server";

export {
  contractStateSnapshotToolName,
  contractStateSnapshotInputSchema,
  contractStateSnapshotDescription,
  createContractStateSnapshotHandler,
} from "./tools/contract-state-snapshot";

export { runSnapshot } from "./core/snapshot";
export type { SnapshotInput, SnapshotDeps } from "./core/snapshot";

export { RpcBatchReader, RpcError, HttpError } from "./rpc/batch-reader";
export type { BatchReaderOptions, SlotRead } from "./rpc/batch-reader";

export { getChain, isKnownChain } from "./chains/registry";
export type { ChainConfig } from "./chains/registry";

export {
  SourcifyMetadataProvider,
  EtherscanMetadataProvider,
  ChainedMetadataProvider,
} from "./metadata";
export type {
  ContractMetadata,
  ContractMetadataProvider,
  SourceFile,
  CompilerSettings,
} from "./metadata/provider";

export {
  compileContract,
  CompileFailure,
  BUNDLED_VERSION,
} from "./layout/compiler";
export type {
  CompiledContract,
  AstNode,
  CompileError,
} from "./layout/compiler";
export { buildLayout } from "./layout/layout-builder";
export type {
  LayoutBuild,
  ConstantDeclaration,
  ImmutableDeclaration,
} from "./layout/layout-builder";
export { compareBytecode } from "./layout/bytecode-comparator";

export {
  decodeValue,
  decodeAllVariables,
  decodeScalar,
} from "./storage/decoder";
export { decodeStruct } from "./storage/decode-struct";
export { decodeArrayVariable } from "./storage/decode-array";
export {
  decodeStringVariable,
  decodeBytesVariableAsync,
} from "./storage/decode-string-bytes";
export {
  evaluateConstant,
  resolveConstants,
  resolveImmutables,
} from "./storage/constant-immutable";
export { parseTypeId, packedByteSize, arrayDepth } from "./storage/type-parser";

export { RpcSlotReader, MapSlotReader } from "./storage/decode-context";
export type { SlotReader } from "./storage/decode-context";

export {
  detectProxy,
  resolveBeaconImplementation,
  getImplementationAddress,
  isEip1167Clone,
  getEip1167Implementation,
  EIP1967_IMPL_SLOT,
  EIP1967_ADMIN_SLOT,
  EIP1967_BEACON_SLOT,
} from "./contracts/proxy-detector";
export { resolveContract } from "./contracts/resolver";

export { renderMarkdown } from "./renderer/markdown";

export * from "./storage/types";
