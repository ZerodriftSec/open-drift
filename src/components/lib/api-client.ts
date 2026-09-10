import { z, type ZodTypeAny } from "zod";

export const emptyResponseSchema = z.object({}).passthrough();
export const errorResponseSchema = z
  .object({
    error: z.unknown().optional(),
  })
  .passthrough();

type ApiRequestInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | null;
  json?: unknown;
};

export class ApiResponseError extends Error {
  readonly payload: unknown;
  readonly status: number;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiResponseError";
    this.payload = payload;
    this.status = status;
  }
}

export async function requestJson<TSchema extends ZodTypeAny>(
  input: RequestInfo | URL,
  init: ApiRequestInit,
  schema: TSchema,
  fallbackMessage: string,
): Promise<z.infer<TSchema>> {
  const { json, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  let body = requestInit.body;

  headers.set("Accept", "application/json");
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }

  const response = await fetch(input, {
    ...requestInit,
    body,
    headers,
  });
  const text = await response.text();
  const payload = parseJsonPayload(text);

  if (!response.ok) {
    throw new ApiResponseError(
      apiErrorMessage(response, payload, fallbackMessage, text),
      response.status,
      payload,
    );
  }

  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw new ApiResponseError(
      `${fallbackMessage}: unexpected response format`,
      response.status,
      payload,
    );
  }

  return parsed.data;
}

export function errorMessage(error: unknown, fallback = "Request failed") {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim();
    return readableApiErrorMessage(message) ?? message;
  }

  if (typeof error === "string" && error.trim()) {
    const message = error.trim();
    return readableApiErrorMessage(message) ?? message;
  }

  return fallback;
}

function parseJsonPayload(text: string) {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function apiErrorMessage(
  response: Response,
  payload: unknown,
  fallbackMessage: string,
  rawText: string,
) {
  const parsed = errorResponseSchema.safeParse(payload);
  if (parsed.success) {
    const error = extractPayloadErrorMessage(parsed.data.error);
    if (error) {
      return error;
    }
  }

  const payloadMessage = extractPayloadErrorMessage(payload);
  if (payloadMessage) {
    return payloadMessage;
  }

  const status = `${response.status} ${response.statusText || "Error"}`;
  const body = rawText.trim();
  return body
    ? `${fallbackMessage} (${status}): ${body}`
    : `${fallbackMessage} (${status})`;
}

function readableApiErrorMessage(message: string) {
  const parsed = parseJsonPayload(message);
  return extractPayloadErrorMessage(parsed);
}

function extractPayloadErrorMessage(
  payload: unknown,
  depth = 0,
): string | null {
  if (depth > 3 || payload == null) {
    return null;
  }

  if (typeof payload === "string") {
    const message = payload.trim();
    if (!message) {
      return null;
    }

    const nested = parseJsonPayload(message);
    if (nested != null && nested !== message) {
      return extractPayloadErrorMessage(nested, depth + 1) ?? message;
    }

    return message;
  }

  if (typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  for (const value of [record.error, record.message]) {
    const message = extractPayloadErrorMessage(value, depth + 1);
    if (message) {
      return message;
    }
  }

  return null;
}
