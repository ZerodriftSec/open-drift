/**
 * Markdown renderer.
 *
 * Produces a single Markdown document that summarizes the snapshot. The
 * format is designed for an LLM to read in one pass:
 *
 *   # Contract State Snapshot
 *   ## Contract
 *   ## Proxy (optional)
 *   ## Storage Variables
 *   ## Constants and Immutables
 *   ## Unsupported Variables (mappings etc.)
 *
 * For deeply-nested values (structs, arrays) we render an inline tree
 * rather than spreading them across multiple top-level sections, because
 * the snapshot is meant to be consumed as a single document.
 */

import type {
  DecodedArray,
  DecodedConstant,
  DecodedImmutable,
  DecodedScalar,
  DecodedStruct,
  DecodedUnsupported,
  DecodedValue,
  SnapshotResult,
} from "../storage/types";

export function renderMarkdown(result: SnapshotResult): string {
  const lines: string[] = [];
  const { meta, variables } = result;

  lines.push("# Contract State Snapshot", "");
  lines.push("## Contract", "");
  lines.push(`- Chain ID: \`${meta.chainId}\``);
  lines.push(`- Contract: \`${meta.contractAddress}\``);
  lines.push(`- Storage address: \`${meta.storageAddress}\``);
  lines.push(
    `- Block: \`${meta.blockNumber}\`${meta.blockHash ? ` (\`${short(meta.blockHash)}\`)` : ""}`,
  );
  lines.push(`- Source: ${meta.verified ? "Verified" : "Unverified"}`);
  if (meta.compilerVersion) {
    lines.push(`- Compiler: \`${meta.compilerVersion}\``);
  }
  lines.push(`- Layout confidence: \`${capitalize(meta.layoutConfidence)}\``);
  if (meta.warnings.length > 0) {
    lines.push("- Warnings:");
    for (const w of meta.warnings) lines.push(`  - ${w}`);
  }
  lines.push("");

  if (meta.proxy && meta.proxy.type !== "none") {
    lines.push("## Proxy", "");
    lines.push(`- Type: \`${capitalize(meta.proxy.type)}\``);
    lines.push(`- Proxy address: \`${meta.proxy.proxyAddress}\``);
    if (meta.proxy.implementationAddress) {
      lines.push(`- Implementation: \`${meta.proxy.implementationAddress}\``);
    }
    if (meta.proxy.beaconAddress) {
      lines.push(`- Beacon: \`${meta.proxy.beaconAddress}\``);
    }
    if (meta.proxy.adminAddress) {
      lines.push(`- Admin: \`${meta.proxy.adminAddress}\``);
    }
    lines.push("- Storage source: Proxy");
    lines.push("- Layout source: Implementation");
    lines.push("");
  }

  const storage = variables.filter(
    (v) =>
      v.kind === "value" ||
      v.kind === "struct" ||
      v.kind === "array" ||
      v.kind === "string" ||
      v.kind === "bytes",
  );
  const constants = variables.filter(
    (v) => v.kind === "constant",
  ) as DecodedConstant[];
  const immutables = variables.filter(
    (v) => v.kind === "immutable",
  ) as DecodedImmutable[];
  const unsupported = variables.filter(
    (v) => v.kind === "unsupported",
  ) as DecodedUnsupported[];

  if (storage.length > 0) {
    lines.push("## Storage Variables", "");
    lines.push("| Variable | Type | Slot | Current Value |");
    lines.push("|---|---|---:|---|");
    for (const v of storage) {
      lines.push(...renderStorageRow(v).map((l) => l));
    }
    lines.push("");
  }

  // Render nested structures (structs/arrays) as their own sections.
  for (const v of storage) {
    if (v.kind === "struct") {
      lines.push(...renderStructSection(v));
    } else if (v.kind === "array") {
      lines.push(...renderArraySection(v));
    }
  }

  if (constants.length > 0 || immutables.length > 0) {
    lines.push("## Constants and Immutables", "");
    lines.push("| Variable | Kind | Value | Source |");
    lines.push("|---|---|---|---|");
    for (const c of constants) {
      lines.push(
        `| \`${c.name}\` | constant | \`${truncate(c.raw)}\` | ${sourceLabel(c.source)} |`,
      );
    }
    for (const im of immutables) {
      lines.push(
        `| \`${im.name}\` | immutable | \`${truncate(im.raw)}\` | ${sourceLabel(im.source)} |`,
      );
    }
    lines.push("");
  }

  if (unsupported.length > 0) {
    lines.push("## Unsupported Variables", "");
    lines.push("| Variable | Type | Base Slot | Reason |");
    lines.push("|---|---|---:|---|");
    for (const u of unsupported) {
      lines.push(
        `| \`${u.name}\` | ${u.displayType} | ${u.baseSlot} | ${u.reason} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderStorageRow(v: DecodedValue): string[] {
  switch (v.kind) {
    case "value":
      return [
        `| \`${v.name}\` | ${v.displayType} | ${slotRef(v)} | ${scalarCell(v)} |`,
      ];
    case "string":
      return [
        `| \`${v.name}\` | string | ${slotRef(v)} | ${v.bytesLength === 0 ? '""' : truncate(JSON.stringify(v.value))} |`,
      ];
    case "bytes":
      return [
        `| \`${v.name}\` | bytes | ${slotRef(v)} | ${truncate(v.rawHex)} (${v.bytesLength} bytes) |`,
      ];
    case "struct":
      return [
        `| \`${v.name}\` | ${v.displayType} | ${slotRef(v)} | see \`Struct: ${v.name}\` below |`,
      ];
    case "array":
      return [
        `| \`${v.name}\` | ${v.displayType} | ${slotRef(v)} | length=${v.length}${v.truncated ? ` (truncated, returned ${v.returnedItems})` : ""} |`,
      ];
    case "unsupported":
      return [
        `| \`${v.name}\` | ${v.displayType} | ${v.baseSlot} | _unsupported_ |`,
      ];
    case "constant":
    case "immutable":
      return []; // rendered in their own section
    default:
      return [];
  }
}

function scalarCell(v: DecodedScalar): string {
  if (v.formatted) return `\`${truncate(v.formatted)}\``;
  return `\`${truncate(v.raw)}\``;
}

function renderStructSection(v: DecodedStruct): string[] {
  const lines: string[] = [];
  lines.push(`## Struct: ${v.name}`, "");
  lines.push("| Member | Type | Slot | Current Value |");
  lines.push("|---|---|---:|---|");
  for (const m of v.members) {
    const rows = renderStorageRow(m);
    lines.push(...rows);
  }
  lines.push("");
  // Recurse into nested structs/arrays within members.
  for (const m of v.members) {
    if (m.kind === "struct") {
      lines.push(`### Nested Struct: ${v.name}.${m.name}`, "");
      lines.push(
        ...renderStructSection(promoteStruct(m, `${v.name}.${m.name}`)),
      );
    } else if (m.kind === "array") {
      lines.push(`### Nested Array: ${v.name}.${m.name}`, "");
      lines.push(...renderArraySection(promoteArray(m, `${v.name}.${m.name}`)));
    }
  }
  return lines;
}

function renderArraySection(v: DecodedArray): string[] {
  const lines: string[] = [];
  lines.push(`## Array: ${v.name}`, "");
  lines.push(`- Type: \`${v.displayType}\``);
  lines.push(`- Base slot: \`${v.slot}\``);
  lines.push(`- Length: \`${v.length}\``);
  lines.push(`- Returned items: \`${v.returnedItems}\``);
  lines.push(`- Truncated: \`${v.truncated}\``);
  lines.push("");
  if (v.items.length > 0) {
    lines.push("| Index | Value |");
    lines.push("|---:|---|");
    for (let i = 0; i < v.items.length; i++) {
      const item = v.items[i];
      lines.push(`| ${i} | ${summarizeItem(item)} |`);
    }
    lines.push("");
  }
  return lines;
}

function summarizeItem(item: DecodedValue): string {
  switch (item.kind) {
    case "value":
    case "constant":
    case "immutable":
      return `\`${truncate(item.formatted ?? item.raw)}\``;
    case "string":
      return `\`${truncate(JSON.stringify(item.value))}\``;
    case "bytes":
      return `\`${truncate(item.rawHex)}\``;
    case "struct":
      return `struct with ${item.members.length} members`;
    case "array":
      return `array of length ${item.length}`;
    case "unsupported":
      return `_unsupported_`;
  }
}

function slotRef(v: { slot: bigint; offset?: number }): string {
  if (v.offset && v.offset > 0) {
    return `${v.slot}:${v.offset}`;
  }
  return `${v.slot}`;
}

function promoteStruct(s: DecodedValue, newName: string): DecodedStruct {
  return { ...(s as DecodedStruct), name: newName };
}

function promoteArray(a: DecodedValue, newName: string): DecodedArray {
  return { ...(a as DecodedArray), name: newName };
}

function truncate(s: string, max = 64): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function short(hex: string): string {
  if (hex.length <= 12) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sourceLabel(source: string): string {
  switch (source) {
    case "source-ast":
      return "Source AST";
    case "public-getter":
      return "Public getter";
    case "runtime-bytecode":
      return "Runtime bytecode";
    case "immutable-references":
      return "Immutable references";
    default:
      return source;
  }
}
