import { NextResponse } from "next/server";

type ZerodriftApiError = {
  code: string;
  details?: unknown;
  message: string;
};

type ZerodriftApiErrorOptions = {
  code?: string;
  details?: unknown;
  message?: string;
  status?: number;
};

export function zerodriftApiErrorResponse(
  error: unknown,
  options: ZerodriftApiErrorOptions = {},
) {
  const normalized = normalizeZerodriftApiError(error, options);

  return NextResponse.json(
    {
      success: false,
      error: normalized.error,
    },
    { status: normalized.status },
  );
}

function normalizeZerodriftApiError(
  error: unknown,
  options: ZerodriftApiErrorOptions,
): { error: ZerodriftApiError; status: number } {
  const message = options.message ?? errorMessage(error);
  return {
    error: {
      code: options.code ?? errorCodeForStatus(options.status ?? 400),
      ...(options.details === undefined ? {} : { details: options.details }),
      message,
    },
    status: options.status ?? 400,
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Request failed";
}

function errorCodeForStatus(status: number) {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status >= 500) return "INTERNAL_ERROR";
  return "BAD_REQUEST";
}
