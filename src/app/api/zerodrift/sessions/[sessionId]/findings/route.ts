import { NextResponse } from "next/server";
import {
  getRequiredSessionDetails,
  toCompatFindings,
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
 * Get session findings
 * @summary Get session findings
 * @description ZeroDrift-compatible endpoint that returns locally or onchain confirmed Agent findings.
 * @tag ZeroDrift Sessions
 * @pathParams SessionIdParams
 * @response 200:CompatFindingsResponse:Compatibility-format findings
 * @add 404:ZerodriftApiErrorResponse:Session not found
 * @openapi
 */
export async function GET(_request: Request, context: RouteContext) {
  void _request;
  try {
    const { sessionId } = await context.params;
    const details = await getRequiredSessionDetails(sessionId, process.cwd());

    return NextResponse.json(toCompatFindings(details));
  } catch (error) {
    return zerodriftApiErrorResponse(error, {
      code: "SESSION_NOT_FOUND",
      status: 404,
    });
  }
}
