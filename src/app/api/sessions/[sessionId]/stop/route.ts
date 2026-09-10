import { NextResponse } from "next/server";
import { stopAppSessionRuntime } from "@/server/runtime/cleanup";
import { getSessionDetails } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Stop audit session
 * @summary Stop audit session
 * @description Cancels a queued or running audit session in the current app runtime. Active Agent turns are aborted, matching queue items are cleared, and the session is marked interrupted.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @response 200:SessionStopResponse:Stopped session metadata
 * @add 404:ErrorResponse:Session not found
 * @openapi
 */
export async function POST(_request: Request, context: RouteContext) {
  void _request;
  const { sessionId } = await context.params;
  const details = await getSessionDetails(sessionId, process.cwd());

  if (!details) {
    return NextResponse.json(
      { error: `Session not found: ${sessionId}` },
      { status: 404 },
    );
  }

  const result = await stopAppSessionRuntime({
    projectRoot: process.cwd(),
    sessionId,
  });

  const activeStop =
    result.abortedTurn || result.clearedQueueItems > 0 || result.interrupted;

  return NextResponse.json({
    ...result,
    message: activeStop ? "Session stopped" : "Session has no running task",
    status: result.status ?? details.state.status,
  });
}
