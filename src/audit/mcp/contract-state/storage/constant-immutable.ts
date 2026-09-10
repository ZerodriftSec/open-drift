/**
 * Constant + Immutable value resolver.
 *
 * Constants: stored in the AST as VariableDeclaration with `constant: true`
 * and a `value` expression. We try to evaluate the expression with a small
 * literal evaluator (numbers, hex literals, address casts, basic arithmetic).
 * If evaluation fails we fall back to a public getter call if the contract
 * exposes one (public constant variables are accessible as functions).
 *
 * Immutables: stored in the deployed bytecode at specific byte offsets
 * (immutableReferences from solc). The values are written by the deployer.
 * We try to read them from the bytecode; if that fails we fall back to a
 * public getter call.
 */

import type { Address, DecodedConstant, DecodedImmutable } from "./types";
import type { CompiledContract } from "../layout/compiler";
import type {
  ConstantDeclaration,
  ImmutableDeclaration,
} from "../layout/layout-builder";
import type { RpcBatchReader } from "../rpc/batch-reader";
import { serializeExpression } from "../layout/layout-builder";
import type { AstNode } from "../layout/compiler";
import { keccak256 } from "viem";

/**
 * Evaluate a constant declaration's value expression, returning a literal
 * string suitable for display. Returns undefined if the expression is too
 * complex to evaluate locally.
 */
export function evaluateConstant(decl: ConstantDeclaration): {
  raw: string;
  formatted?: string;
} {
  // Prefer the public getter for runtime constants if the contract exposes
  // one; here we just evaluate the AST expression.
  if (decl.rawValue) {
    return { raw: decl.rawValue };
  }
  if (decl.value) {
    const evaluated = evalExpression(decl.value);
    if (evaluated !== undefined) return { raw: evaluated };
    return { raw: serializeExpression(decl.value) };
  }
  return { raw: "" };
}

/** Best-effort literal evaluator. Handles numbers, hex, addresses, arithmetic. */
function evalExpression(node: AstNode): string | undefined {
  if (!node) return undefined;
  switch (node.nodeType) {
    case "Literal": {
      const value = String(node.value ?? "");
      const sub = String(node.subExpression ?? "");
      if (sub === "hex") return `hex"${value}"`;
      if (sub === "address") return value;
      if (sub === "number") {
        return String(parseNumericLiteral(value, node));
      }
      if (sub === "string") {
        return JSON.stringify(value);
      }
      return value;
    }
    case "UnaryOperation": {
      const inner = evalExpression(node.subExpression as AstNode);
      if (inner === undefined) return undefined;
      const op = String(node.operator ?? "");
      if (op === "-") {
        const n = BigInt(inner);
        return (-n).toString();
      }
      return `${op}${inner}`;
    }
    case "BinaryOperation": {
      const left = evalExpression(node.leftExpression as AstNode);
      const right = evalExpression(node.rightExpression as AstNode);
      const op = String(node.operator ?? "");
      if (left === undefined || right === undefined) return undefined;
      if (/^[0-9]+$/.test(left) && /^[0-9]+$/.test(right)) {
        try {
          const a = BigInt(left);
          const b = BigInt(right);
          switch (op) {
            case "+":
              return (a + b).toString();
            case "-":
              return (a - b).toString();
            case "*":
              return (a * b).toString();
            case "/":
              return (a / b).toString();
            case "%":
              return (a % b).toString();
            case "**":
              return (a ** b).toString();
            case "<<":
              return (a << b).toString();
            case ">>":
              return (a >> b).toString();
            case "&":
              return (a & b).toString();
            case "|":
              return (a | b).toString();
            case "^":
              return (a ^ b).toString();
          }
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function parseNumericLiteral(value: string, node: AstNode): bigint | string {
  // Strip underscores and unit suffixes
  const cleaned = value.replace(/_/g, "");
  const unit = node.unitName ? String(node.unitName) : "";
  const denominator =
    unit === "ether"
      ? 1_000_000_000_000_000_000n
      : unit === "gwei"
        ? 1_000_000_000n
        : unit === "wei"
          ? 1n
          : 1n;
  try {
    if (cleaned.startsWith("0x")) {
      const n = BigInt(cleaned);
      return n * denominator;
    }
    const n = BigInt(cleaned);
    return n * denominator;
  } catch {
    return value;
  }
}

/**
 * Build public-getter selector for a constant/immutable. Public getters are
 * view functions with no arguments and the same name as the variable.
 */
export function getterSelector(name: string): `0x${string}` {
  // keccak256("name()")[:4]
  const hash = keccak256(
    `0x${Buffer.from(`${name}()`).toString("hex")}` as `0x${string}`,
  );
  return hash.slice(0, 10) as `0x${string}`;
}

/**
 * Resolve all constants in the layout. Returns DecodedConstant entries.
 * If `useGetter` is true and a getter exists, calls the chain to verify.
 */
export async function resolveConstants(
  decls: ConstantDeclaration[],
  compiled: CompiledContract,
  rpc: RpcBatchReader,
  storageAddress: Address,
  blockNumber: bigint,
  useGetter = true,
): Promise<DecodedConstant[]> {
  const out: DecodedConstant[] = [];
  for (const decl of decls) {
    const evaluated = evaluateConstant(decl);
    if (evaluated.raw === "" && useGetter) {
      const fromGetter = await tryGetter(
        rpc,
        storageAddress,
        blockNumber,
        decl.name,
        compiled,
      );
      if (fromGetter !== undefined) {
        out.push({
          name: decl.name,
          displayType: decl.typeName,
          slot: 0n,
          kind: "constant",
          raw: fromGetter,
          source: "public-getter",
        });
        continue;
      }
    }
    out.push({
      name: decl.name,
      displayType: decl.typeName,
      slot: 0n,
      kind: "constant",
      raw: evaluated.raw,
      formatted: evaluated.formatted,
      source: "source-ast",
    });
  }
  return out;
}

/**
 * Resolve all immutables. Strategy:
 *   1. Try a public getter call (works for public immutables).
 *   2. Else read from the deployed bytecode using immutableReferences.
 *   3. Else fall back to source expression (no value).
 */
export async function resolveImmutables(
  decls: ImmutableDeclaration[],
  compiled: CompiledContract,
  onChainBytecode: `0x${string}`,
  rpc: RpcBatchReader,
  storageAddress: Address,
  blockNumber: bigint,
): Promise<DecodedImmutable[]> {
  const out: DecodedImmutable[] = [];
  for (const decl of decls) {
    // 1. Try public getter
    const fromGetter = await tryGetter(
      rpc,
      storageAddress,
      blockNumber,
      decl.name,
      compiled,
    ).catch(() => undefined);
    if (fromGetter !== undefined) {
      out.push({
        name: decl.name,
        displayType: decl.typeName,
        slot: 0n,
        kind: "immutable",
        raw: fromGetter,
        source: "public-getter",
      });
      continue;
    }
    // 2. Try immutableReferences
    const fromBytecode = readImmutableFromBytecode(
      decl,
      compiled.immutableReferences,
      onChainBytecode,
    );
    if (fromBytecode !== undefined) {
      out.push({
        name: decl.name,
        displayType: decl.typeName,
        slot: 0n,
        kind: "immutable",
        raw: fromBytecode,
        source: "immutable-references",
      });
      continue;
    }
    // 3. Give up
    out.push({
      name: decl.name,
      displayType: decl.typeName,
      slot: 0n,
      kind: "immutable",
      raw: "",
      source: "runtime-bytecode",
    });
  }
  return out;
}

function readImmutableFromBytecode(
  decl: ImmutableDeclaration,
  immutableRefs: CompiledContract["immutableReferences"],
  bytecode: `0x${string}`,
): string | undefined {
  // immutableReferences is keyed by astId of the immutable declaration.
  // Each value is a list of { start, length } byte offsets in the bytecode.
  const refs = immutableRefs[String(decl.astId)];
  if (!refs || refs.length === 0) return undefined;
  const first = refs[0];
  const hex = bytecode.slice(2);
  const start = first.start * 2;
  const len = first.length * 2;
  if (start + len > hex.length) return undefined;
  return `0x${hex.slice(start, start + len)}` as `0x${string}`;
}

async function tryGetter(
  rpc: RpcBatchReader,
  storageAddress: Address,
  blockNumber: bigint,
  name: string,
  compiled: CompiledContract,
): Promise<string | undefined> {
  // Verify the ABI actually has a public getter for this name.
  const abi = Array.isArray(compiled.abi) ? compiled.abi : [];
  const hasGetter = abi.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: string }).type === "function" &&
      (entry as { name?: string }).name === name &&
      Array.isArray((entry as { inputs?: unknown[] }).inputs) &&
      (entry as { inputs?: unknown[] }).inputs!.length === 0 &&
      (entry as { stateMutability?: string }).stateMutability === "view",
  );
  if (!hasGetter) return undefined;
  try {
    const selector = getterSelector(name);
    const result = await rpc.ethCall(storageAddress, selector, blockNumber);
    return result;
  } catch {
    return undefined;
  }
}
