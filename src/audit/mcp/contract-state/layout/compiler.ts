/**
 * Solc compiler wrapper.
 *
 * Compiles a contract's sources with its original settings and returns the
 * artifacts we need to build a storage layout: storageLayout, AST, deployed
 * bytecode, and immutableReferences.
 *
 * Version handling: the `solc` npm package bundles one specific compiler
 * version. When the contract was originally compiled with a different version,
 * we still attempt compilation — most storageLayout output is stable across
 * 0.8.x versions. The snapshot pipeline surfaces the version mismatch as a
 * `metadata-difference` confidence rather than refusing to compile.
 */

import solc from "solc";
import type { CompilerSettings, ContractMetadata } from "../metadata/provider";
import type { Address, SolcStorageLayout } from "../storage/types";

export interface CompiledContract {
  contractName: string;
  contractPath: string;
  abi: unknown[];
  storageLayout: SolcStorageLayout;
  ast?: AstNode;
  deployedBytecode: `0x${string}`;
  immutableReferences: Record<string, Array<{ start: number; length: number }>>;
}

export interface CompileError {
  sourceLocation?: { file: string; start: number; end: number };
  type: string;
  component: string;
  severity: "error" | "warning";
  message: string;
  formattedMessage?: string;
}

export class CompileFailure extends Error {
  constructor(
    message: string,
    public readonly errors: CompileError[] = [],
  ) {
    super(message);
    this.name = "CompileFailure";
  }
}

export interface AstNode {
  nodeType: string;
  name?: string;
  id?: number;
  src?: string;
  absolutePath?: string;
  nodes?: AstNode[];
  members?: AstNode[];
  declarations?: AstNode[];
  body?: AstNode;
  // Many other fields exist; we treat the AST as a generic tree.
  [key: string]: unknown;
}

interface SolcSuccess {
  contracts: Record<string, Record<string, unknown>>;
  sources: Record<string, { ast: AstNode; id: number }>;
  errors?: CompileError[];
}

interface SolcStandardInput {
  language: "Solidity";
  sources: Record<string, { content: string }>;
  settings: {
    optimizer?: { enabled: boolean; runs?: number };
    viaIR?: boolean;
    evmVersion?: string;
    libraries?: Record<string, Record<string, string>>;
    outputSelection: Record<string, Record<string, string[]>>;
  };
}

const BUNDLED_VERSION = (solc as unknown as { version(): string }).version();

function buildStandardInput(meta: ContractMetadata): SolcStandardInput {
  const sources: Record<string, { content: string }> = {};
  for (const s of meta.sources) {
    sources[s.path] = { content: s.content };
  }

  const settings: SolcStandardInput["settings"] = {
    outputSelection: {
      "*": {
        "*": [
          "abi",
          "storageLayout",
          "evm.deployedBytecode",
          "evm.immutableReferences",
        ],
        "": ["ast"],
      },
    },
  };

  if (meta.compiler.optimizer) {
    settings.optimizer = {
      enabled: meta.compiler.optimizer.enabled,
      runs: meta.compiler.optimizer.runs,
    };
  }
  if (meta.compiler.viaIR) settings.viaIR = true;
  if (meta.compiler.evmVersion) settings.evmVersion = meta.compiler.evmVersion;
  if (meta.compiler.libraries) settings.libraries = meta.compiler.libraries;

  return { language: "Solidity", sources, settings };
}

/**
 * Compile all sources in the metadata and return the artifacts for the
 * named target contract.
 *
 * If `meta.standardJsonInput` is provided by the metadata provider, we use
 * it directly (the metadata provider has already configured output selection
 * correctly). Otherwise we build the standard input ourselves.
 */
export async function compileContract(
  meta: ContractMetadata,
  targetName?: string,
): Promise<CompiledContract> {
  const rawInput: SolcStandardInput =
    (meta.standardJsonInput as SolcStandardInput | undefined) ??
    buildStandardInput(meta);

  // Ensure outputSelection covers what we need.
  ensureOutputSelection(rawInput);

  const inputJson = JSON.stringify(rawInput);
  const findImports = (
    path: string,
  ): { contents: string } | { error: string } => {
    const src = meta.sources.find(
      (s) => s.path === path || s.path.endsWith("/" + path),
    );
    if (src) return { contents: src.content };
    return { error: `File not found: ${path}` };
  };

  const rawOutput = (
    solc.compile as (input: string, options?: unknown) => string
  )(inputJson, { import: findImports });
  const output = JSON.parse(rawOutput) as
    SolcSuccess | { errors: CompileError[] };

  if ("errors" in output && output.errors && !("contracts" in output)) {
    const errs = output.errors.filter((e) => e.severity === "error");
    if (errs.length > 0) {
      throw new CompileFailure(
        `solc ${BUNDLED_VERSION} reported ${errs.length} error(s); first: ${errs[0]?.formattedMessage ?? errs[0]?.message}`,
        output.errors,
      );
    }
  }

  const success = output as SolcSuccess;
  const severeErrors = (success.errors ?? []).filter(
    (e) => e.severity === "error",
  );
  if (severeErrors.length > 0) {
    throw new CompileFailure(
      `solc ${BUNDLED_VERSION} failed: ${severeErrors[0]?.formattedMessage ?? severeErrors[0]?.message}`,
      severeErrors,
    );
  }

  if (!success.contracts || Object.keys(success.contracts).length === 0) {
    throw new CompileFailure(
      `solc produced no contracts (version ${BUNDLED_VERSION})`,
    );
  }

  const { contractPath, contractName, entry } = pickContract(
    success.contracts,
    meta,
    targetName,
  );

  const abi = (entry.abi ?? []) as unknown[];
  const storageLayout = (entry.storageLayout ?? {
    storage: [],
    types: {},
  }) as SolcStorageLayout;

  // AST is under sources keyed by source file path.
  const ast = success.sources[contractPath]?.ast;

  const deployedBytecode = ((
    (entry.evm as { deployedBytecode?: { object?: string } }) ?? {}
  ).deployedBytecode?.object ?? "0x") as `0x${string}`;

  const immutableReferences = ((
    (entry.evm as { immutableReferences?: Record<string, unknown> }) ?? {}
  ).immutableReferences ?? {}) as Record<
    string,
    Array<{ start: number; length: number }>
  >;

  return {
    contractName,
    contractPath,
    abi,
    storageLayout,
    ast,
    deployedBytecode,
    immutableReferences,
  };
}

function ensureOutputSelection(input: SolcStandardInput): void {
  input.settings.outputSelection ??= {};
  const want = {
    "*": {
      "*": [
        "abi",
        "storageLayout",
        "evm.deployedBytecode",
        "evm.immutableReferences",
      ],
      "": ["ast"],
    },
  };
  // Merge want into input.settings.outputSelection without clobbering
  // anything the metadata provider already set.
  for (const [file, byContract] of Object.entries(want)) {
    if (!input.settings.outputSelection[file]) {
      input.settings.outputSelection[file] = {};
    }
    for (const [contract, fields] of Object.entries(byContract)) {
      const have = input.settings.outputSelection[file][contract] ?? [];
      input.settings.outputSelection[file][contract] = [
        ...new Set([...have, ...fields]),
      ];
    }
  }
}

function pickContract(
  contracts: SolcSuccess["contracts"],
  meta: ContractMetadata,
  targetName?: string,
): {
  contractPath: string;
  contractName: string;
  entry: Record<string, unknown>;
} {
  // Build a flat list of contract entries.
  const flat: Array<{
    path: string;
    name: string;
    entry: Record<string, unknown>;
  }> = [];
  for (const [path, byName] of Object.entries(contracts)) {
    for (const [name, entry] of Object.entries(byName)) {
      flat.push({ path, name, entry: entry as Record<string, unknown> });
    }
  }

  if (flat.length === 0) {
    throw new CompileFailure("no contract entries in solc output");
  }

  const expectedName = targetName ?? meta.contractName;
  const expectedPath = meta.targetContractPath;

  if (expectedPath) {
    const match = flat.find(
      (c) => c.path === expectedPath && c.name === expectedName,
    );
    if (match)
      return {
        contractPath: match.path,
        contractName: match.name,
        entry: match.entry,
      };
  }
  if (expectedName) {
    const match = flat.find((c) => c.name === expectedName);
    if (match)
      return {
        contractPath: match.path,
        contractName: match.name,
        entry: match.entry,
      };
  }
  const first = flat[0];
  return {
    contractPath: first.path,
    contractName: first.name,
    entry: first.entry,
  };
}

export { BUNDLED_VERSION };

export type { Address, CompilerSettings };
