import { NextResponse } from "next/server";
import { refreshSessionWorkflowSnapshot } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Refresh session Workflow snapshot
 * @summary Refresh session Workflow snapshot
 * @description Replaces the stored Session Workflow snapshot with the latest definition resolved from its current Workflow ID. Existing Workflow execution state is preserved. Running Sessions cannot be refreshed.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @response 200:SessionWorkflowRefreshResponse:Refreshed Workflow snapshot
 * @add 400:ErrorResponse:Workflow refresh failed
 * @add 404:ErrorResponse:Session not found
 * @add 409:ErrorResponse:Session is running
 * @openapi
 */
export async function POST(_request: Request, context: RouteContext) {
  void _request;
  const { sessionId } = await context.params;

  try {
    return NextResponse.json(await refreshSessionWorkflowSnapshot(sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found")
      ? 404
      : message.includes("is running")
        ? 409
        : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
