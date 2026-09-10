import { NextResponse } from "next/server";
import {
  getRequiredSessionDetails,
  toCompatProgress,
} from "@/server/sessions/compat";
import { zerodriftApiErrorResponse } from "@/server/zerodrift/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Get session status
 * @summary Get session status
 * @description ZeroDrift-compatible status polling endpoint. The payload matches the progress endpoint.
 * @tag ZeroDrift Sessions
 * @pathParams SessionIdParams
 * @response 200:CompatProgressResponse:Session status
 * @add 404:ZerodriftApiErrorResponse:Session not found
 * @openapi
 */
export async function GET(_request: Request, context: RouteContext) {
  void _request;
  try {
    const { sessionId } = await context.params;
    const details = await getRequiredSessionDetails(sessionId, process.cwd(), {
      logLimit: 100,
    });

    return NextResponse.json(await toCompatProgress(details));
  } catch (error) {
    return zerodriftApiErrorResponse(error, {
      code: "SESSION_NOT_FOUND",
      status: 404,
    });
  }
}
