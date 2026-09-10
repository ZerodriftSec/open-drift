import { NextResponse } from "next/server";
import { dequeueSession } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Dequeue audit session
 * @summary Dequeue audit session
 * @description Removes an unclaimed queued Session from the persistent queue and changes its lifecycle status to wait. Claimed or running Sessions cannot be dequeued.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @response 200:SessionDequeueResponse:Dequeued session metadata
 * @add 404:ErrorResponse:Session not found
 * @add 409:ErrorResponse:Session cannot be dequeued
 * @openapi
 */
export async function POST(_request: Request, context: RouteContext) {
  void _request;
  const { sessionId } = await context.params;

  try {
    return NextResponse.json(await dequeueSession(sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
