import type { JsonObject, JsonValue } from "@/audit/session/types";

export const DEFAULT_TASK_SOURCE = "audit-platform";

export type TaskMetadata = JsonObject;

export function taskSourceFromMetadata(
  metadata: TaskMetadata | undefined,
): string | undefined {
  return normalizeTaskSource(metadata?.source);
}

export function normalizeTaskSource(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export function taskSourceOrDefault(value: unknown): string {
  return normalizeTaskSource(value) ?? DEFAULT_TASK_SOURCE;
}

export function metadataWithoutTaskSource(
  metadata: TaskMetadata | undefined,
): TaskMetadata | undefined {
  if (!metadata || !Object.hasOwn(metadata, "source")) {
    return metadata;
  }

  const rest: TaskMetadata = { ...metadata };
  delete rest.source;

  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function splitTaskMetadata(metadata: TaskMetadata | undefined): {
  metadata?: TaskMetadata;
  source?: string;
} {
  return {
    metadata: metadataWithoutTaskSource(metadata),
    source: taskSourceFromMetadata(metadata),
  };
}

export function normalizeTaskMetadata(
  value: unknown,
): TaskMetadata | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = typeof value === "string" ? parseMetadataString(value) : value;
  if (parsed === undefined) {
    return undefined;
  }

  if (!isPlainObject(parsed)) {
    throw new Error("metadata must be a JSON object.");
  }

  return normalizeJsonObject(parsed);
}

export function normalizeTaskMetadataWithSource(
  value: unknown,
  source: unknown,
): TaskMetadata | undefined {
  const metadata = normalizeTaskMetadata(value);
  const normalizedSource = normalizeTaskSource(source);

  if (!normalizedSource) {
    return metadata;
  }

  return {
    ...(metadata ?? {}),
    source: normalizedSource,
  };
}

export function mergeTaskMetadata(
  base: TaskMetadata | undefined,
  override: TaskMetadata | undefined,
): TaskMetadata | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }

  return {
    ...base,
    ...override,
  };
}

function parseMetadataString(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("metadata is not valid JSON.");
  }
}

function normalizeJsonObject(value: Record<string, unknown>): TaskMetadata {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeJsonValue(item)]),
  );
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("metadata cannot contain non-finite numbers.");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }

  if (isPlainObject(value)) {
    return normalizeJsonObject(value);
  }

  throw new Error("metadata can only contain JSON values.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
