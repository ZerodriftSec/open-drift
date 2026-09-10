import { readFile } from "node:fs/promises";
import {
  parse as parseToml,
  stringify as stringifyToml,
  type TomlTable,
  type TomlValue,
} from "smol-toml";

export async function codexConfigOverrides() {
  const source = await readFile(
    new URL("./default.toml", import.meta.url),
    "utf8",
  );
  return flattenTomlTable(parseToml(source, { integersAsBigInt: true }));
}

function flattenTomlTable(table: TomlTable, prefix: string[] = []): string[] {
  return Object.entries(table).flatMap(([key, value]) => {
    const path = [...prefix, formatTomlKey(key)];
    return isTomlTable(value)
      ? flattenTomlTable(value, path)
      : [`${path.join(".")}=${formatTomlValue(value)}`];
  });
}

function formatTomlKey(key: string) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function formatTomlValue(value: TomlValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(formatTomlValue).join(", ")}]`;
  }
  if (isTomlTable(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => `${formatTomlKey(key)} = ${formatTomlValue(item)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }

  return stringifyToml({ value }).trim().slice("value = ".length);
}

function isTomlTable(value: TomlValue): value is TomlTable {
  return (
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}
