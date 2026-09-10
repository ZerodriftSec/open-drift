import { access } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  createLogTailCursor,
  readNextLogBatch,
} from "@/server/sessions/log-tail";
import { formatAgentLogDocument } from "@/lib/agent-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pollIntervalMs = 1_000;
const heartbeatIntervalMs = 15_000;
const maxBatchesPerPoll = 20;
const defaultJsonLogLimit = 100;

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Get session logs
 * @summary Get session logs
 * @description Returns standard JSONL log entries. Use limit=all for every JSON log, format=text for plain text, or format=stream for Server-Sent Events.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @params SessionLogsQueryParams
 * @response 200:SessionLogsResponse:Session logs
 * @add 404:ErrorResponse:Session not found
 * @openapi
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const format = url.searchParams.get("format");
    const logStream = requestedLogStream(url);

    if (format === "stream" || wantsEventStream(request)) {
      const logFile = await getSessionLogFilePath(
        sessionId,
        process.cwd(),
        logStream,
      );
      return createLogStreamResponse(
        request,
        logFile,
        requestedOffset(request, url),
      );
    }

    const { getSessionDetails } = await import("@/server/sessions");
    const details = await getSessionDetails(sessionId, process.cwd(), {
      logLimit: format === "text" ? "all" : requestedLogLimit(url),
      logStream,
    });
    if (!details) throw new Error(`Session not found: ${sessionId}`);

    if (format === "text") {
      const text = formatAgentLogDocument(details.logs, {
        sessionId,
        source: logStream,
      });
      return new Response(text, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return NextResponse.json({
      logOffset: details.logOffset,
      logs: details.logs,
      returnedLogCount: details.logs.length,
      totalLogCount: details.totalLogCount,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 404 },
    );
  }
}

async function getSessionLogFilePath(
  sessionId: string,
  projectRoot: string,
  logStream: "agent" | "program",
) {
  assertSafeDataId(sessionId, "sessionId");

  const sessionDir = path.resolve(projectRoot, ".data", "session", sessionId);
  const logFile = path.join(sessionDir, `${logStream}.log`);

  if (!isPathInside(logFile, sessionDir)) {
    throw new Error(`Session log not found: ${sessionId}`);
  }

  try {
    await access(logFile);
  } catch {
    throw new Error(`Session log not found: ${sessionId}`);
  }

  return logFile;
}

function requestedLogStream(url: URL): "agent" | "program" {
  return url.searchParams.get("source") === "program" ? "program" : "agent";
}

function createLogStreamResponse(
  request: Request,
  logFile: string,
  after: number,
) {
  const encoder = new TextEncoder();
  const cursor = createLogTailCursor(after);
  let closed = false;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  let pollId: ReturnType<typeof setInterval> | undefined;
  let polling = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        closed = true;
        if (heartbeatId) windowlessClearInterval(heartbeatId);
        if (pollId) windowlessClearInterval(pollId);
      };
      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      };
      const send = (content: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(content));
        } catch {
          cleanup();
        }
      };
      const sendEvent = (
        event: string,
        data: Record<string, unknown>,
        id = cursor.emittedOffset,
      ) => {
        send(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const poll = async () => {
        if (closed || polling) return;
        polling = true;

        try {
          for (let index = 0; index < maxBatchesPerPoll; index += 1) {
            const batch = await readNextLogBatch(logFile, cursor);
            if (!batch) break;

            if (batch.rotated) {
              sendEvent(
                "rotated",
                {
                  inode: batch.inode,
                  offset: batch.offset,
                  size: batch.size,
                },
                batch.offset,
              );
            }

            if (batch.logs.length === 0) {
              break;
            }

            sendEvent(
              "logs",
              {
                logs: batch.logs,
                offset: batch.offset,
                size: batch.size,
              },
              batch.offset,
            );
          }
        } catch (error) {
          sendEvent("tail-error", { message: errorMessage(error) });
        } finally {
          polling = false;
        }
      };

      request.signal.addEventListener("abort", close, { once: true });
      send("retry: 1000\n\n");
      sendEvent("ready", { offset: cursor.emittedOffset });

      void poll();
      pollId = setInterval(() => {
        void poll();
      }, pollIntervalMs);
      heartbeatId = setInterval(() => {
        send(`: heartbeat ${Date.now()}\n\n`);
      }, heartbeatIntervalMs);
    },
    cancel() {
      closed = true;
      if (heartbeatId) windowlessClearInterval(heartbeatId);
      if (pollId) windowlessClearInterval(pollId);
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function wantsEventStream(request: Request) {
  return request.headers.get("accept")?.includes("text/event-stream") ?? false;
}

function requestedOffset(request: Request, url: URL) {
  return numericOffset(
    request.headers.get("last-event-id") ??
      url.searchParams.get("after") ??
      undefined,
  );
}

function requestedLogLimit(url: URL) {
  const value = url.searchParams.get("limit")?.trim().toLowerCase();
  if (!value) {
    return defaultJsonLogLimit;
  }

  if (value === "all") {
    return "all";
  }

  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : defaultJsonLogLimit;
}

function numericOffset(value: string | undefined) {
  if (!value) return 0;
  const offset = Number(value);
  return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
}

function assertSafeDataId(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isPathInside(filePath: string, directoryPath: string) {
  const relativePath = path.relative(directoryPath, filePath);
  return (
    Boolean(relativePath) &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function windowlessClearInterval(id: ReturnType<typeof setInterval>) {
  clearInterval(id);
}
