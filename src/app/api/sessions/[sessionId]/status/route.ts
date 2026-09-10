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
 * Get session status
 * @summary Get session status
 * @description Returns the provider-neutral AuditSession snapshot.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @response 200:AuditSessionSnapshot:Session status
 * @add 404:ErrorResponse:Session not found
 * @openapi
 */
export async function GET(_request: Request, context: RouteContext) {
  void _request;
  try {
    const { sessionId } = await context.params;
    const details = await getSessionDetails(sessionId, process.cwd(), {
      logLimit: 0,
    });
    if (!details) throw new Error(`Session not found: ${sessionId}`);

    return NextResponse.json(details.state);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 404 },
    );
  }
}
