import { NextResponse } from "next/server";
import { getSessionDetails } from "@/server/sessions";

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
 * @description Returns the session's locally or onchain confirmed Agent findings.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @response 200:FindingsResponse:Session findings
 * @add 404:ErrorResponse:Session not found
 * @openapi
 */
export async function GET(_request: Request, context: RouteContext) {
  void _request;
  try {
    const { sessionId } = await context.params;
    const details = await getSessionDetails(sessionId, process.cwd());
    if (!details) throw new Error(`Session not found: ${sessionId}`);

    return NextResponse.json({
      findings: details.findings,
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
