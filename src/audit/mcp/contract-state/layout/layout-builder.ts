/**
 * Storage layout builder.
 *
 * Turns solc's `storageLayout` (storage[] entries with typeId references to
 * types{}) into our normalized StorageVariable[] enriched with byteSize,
 * offset, displayType, and kind.
 *
 * Also extracts enum definitions and constant/immutable declarations from
 * the AST so later phases (decoder, constant/immutable handlers) can use
 * them without re-walking the tree.
 */

import type { CompiledContract, AstNode } from "./compiler";
import type {
  EnumDefinition,
  StorageVariable,
  SolcStorageLayout,
} from "../storage/types";

export interface LayoutBuild {
  variables: StorageVariable[];
  enums: EnumDefinition[];
  constants: ConstantDeclaration[];
  immutables: ImmutableDeclaration[];
  types: SolcStorageLayout["types"];
}

export interface ConstantDeclaration {
  name: string;
  typeName: string;
  nodeType: string;
  value?: AstNode;
  rawValue?: string;
  contractName: string;
  visibility: string;
}

export interface ImmutableDeclaration {
  name: string;
  typeName: string;
  contractName: string;
  visibility: string;
  astId: number;
}

function classifyKind(
  typeId: string | undefined,
  declaration: ConstantDeclaration | undefined,
): StorageVariable["kind"] {
  if (declaration) return "constant";
  if (!typeId) return "storage";
  if (typeId.startsWith("t_mapping")) return "mapping";
  return "storage";
}

/**
 * Build the normalized layout. The AST is needed for enum members and for
 * locating constant/immutable declarations; if absent we still produce the
 * variable list but no constants/enums.
 */
export function buildLayout(compiled: CompiledContract): LayoutBuild {
  const types = compiled.storageLayout.types ?? {};
  const variables: StorageVariable[] = [];

  for (const entry of compiled.storageLayout.storage) {
    const typeId = entry.type;
    const typeInfo = types[typeId];
    const byteSize = typeInfo ? Number(typeInfo.numberOfBytes) || 0 : 0;
    const displayType = typeInfo?.label ?? typeId;
    const kind = classifyKind(typeId, undefined);
    variables.push({
      name: entry.label,
      label: entry.label,
      typeId,
      displayType,
      slot: BigInt(entry.slot),
      offset: Number(entry.offset) || 0,
      byteSize,
      contractName: entry.contract,
      kind,
    });
  }

  const enums = extractEnums(compiled.ast);
  const { constants, immutables } = extractConstantsAndImmutables(compiled.ast);

  return { variables, enums, constants, immutables, types };
}

/** Walk the AST looking for `enum` definitions. */
function extractEnums(ast: AstNode | undefined): EnumDefinition[] {
  if (!ast) return [];
  const out: EnumDefinition[] = [];
  walk(ast, (node) => {
    if (node.nodeType === "EnumDefinition" && node.name) {
      out.push({
        name: node.name,
        members: (node.members ?? []).map((m) => String(m.name ?? "")),
      });
    }
  });
  return out;
}

/** Walk the AST looking for `const`/`immutable` state variable declarations. */
function extractConstantsAndImmutables(ast: AstNode | undefined): {
  constants: ConstantDeclaration[];
  immutables: ImmutableDeclaration[];
} {
  const constants: ConstantDeclaration[] = [];
  const immutables: ImmutableDeclaration[] = [];
  if (!ast) return { constants, immutables };

  walkWithContract(ast, (node, contractName) => {
    if (node.nodeType !== "VariableDeclaration") return;
    if (!node.stateVariable && node.constant === false) return;
    const isConstant = node.constant === true;
    const isImmutable = (node.mutability ?? "mutable") === "immutable";
    if (!isConstant && !isImmutable) return;
    if (!node.name) return;

    const typeName = serializeTypeNode(node.typeName as AstNode | undefined);
    const visibility = String(node.visibility ?? "public");
    const contract = contractName ?? "<unknown>";

    if (isConstant) {
      constants.push({
        name: String(node.name),
        typeName,
        nodeType: typeName,
        value: node.value as AstNode | undefined,
        rawValue: node.value
          ? serializeExpression(node.value as AstNode)
          : undefined,
        contractName: contract,
        visibility,
      });
    } else {
      if (typeof node.id !== "number") return;
      immutables.push({
        name: String(node.name),
        typeName,
        contractName: contract,
        visibility,
        astId: node.id,
      });
    }
  });

  return { constants, immutables };
}

function serializeTypeNode(node: AstNode | undefined | null): string {
  if (!node) return "unknown";
  switch (node.nodeType) {
    case "ElementaryTypeName":
      return String(node.name ?? "unknown");
    case "UserDefinedTypeName":
      return String(
        ((node.pathNode as AstNode | undefined)?.name as string | undefined) ??
          node.name ??
          "unknown",
      );
    case "ArrayTypeName":
      return `${serializeTypeNode(node.baseType as AstNode | undefined)}[${
        node.length ? serializeExpression(node.length as AstNode) : ""
      }]`;
    case "Mapping":
      return `mapping(${serializeTypeNode(node.keyType as AstNode)} => ${serializeTypeNode(
        node.valueType as AstNode,
      )})`;
    default:
      return String(node.name ?? node.nodeType ?? "unknown");
  }
}

/** Best-effort string serialization of an AST literal/expression. */
function serializeExpression(node: AstNode): string {
  if (!node) return "";
  switch (node.nodeType) {
    case "Literal": {
      const value = String(node.value ?? "");
      const sub = String(node.subExpression ?? "");
      if (sub === "hex") return `hex"${value}"`;
      if (sub === "address") return `address(${value})`;
      return value;
    }
    case "UnaryOperation":
      return `${node.operator ?? ""}${serializeExpression(node.subExpression as AstNode)}`;
    case "BinaryOperation":
      return `${serializeExpression(node.leftExpression as AstNode)} ${
        node.operator ?? ""
      } ${serializeExpression(node.rightExpression as AstNode)}`;
    case "Identifier":
      return String(node.name ?? "");
    case "MemberAccess":
      return `${serializeExpression(node.expression as AstNode)}.${String(
        node.memberName ?? "",
      )}`;
    case "TupleExpression":
      return (
        (node.components as AstNode[] | undefined)
          ?.filter(Boolean)
          .map(serializeExpression)
          .join(", ") ?? ""
      );
    case "FunctionCall":
      return `${serializeExpression(node.expression as AstNode)}(${(
        node.arguments as AstNode[] | undefined
      )
        ?.filter(Boolean)
        .map(serializeExpression)
        .join(", ")})`;
    default:
      return String(node.name ?? node.nodeType ?? "");
  }
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const v of value) {
        if (isAstNode(v)) walk(v, visit);
      }
    } else if (isAstNode(value)) {
      walk(value, visit);
    }
  }
}

function walkWithContract(
  node: AstNode,
  visit: (n: AstNode, contract: string | undefined) => void,
  contract?: string,
): void {
  if (node.nodeType === "ContractDefinition" && node.name) {
    contract = String(node.name);
  }
  visit(node, contract);
  for (const key of Object.keys(node)) {
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const v of value) {
        if (isAstNode(v)) walkWithContract(v, visit, contract);
      }
    } else if (isAstNode(value)) {
      walkWithContract(value, visit, contract);
    }
  }
}

function isAstNode(v: unknown): v is AstNode {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { nodeType?: unknown }).nodeType === "string"
  );
}

export { serializeExpression, serializeTypeNode };
