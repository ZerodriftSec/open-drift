import { NextResponse } from "next/server";
import { deleteSession } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Delete audit session
 * @summary Delete audit session
 * @description Deletes a stored audit session and its runtime artifacts when it is no longer active.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @response 200:DeleteSessionResponse:Deleted session ID
 * @add 404:ErrorResponse:Session not found
 * @openapi
 */
export async function DELETE(_request: Request, context: RouteContext) {
  void _request;
  const { sessionId } = await context.params;

  try {
    const result = await deleteSession({
      projectRoot: process.cwd(),
      sessionId,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 400 },
    );
  }
}
