import { NextResponse } from "next/server";
import { RunStageError, runStage } from "@/audit/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
    stageIndex: string;
  }>;
};

/**
 * Run workflow stage
 * @summary Run workflow stage
 * @description Synchronously runs every Turn in one Workflow Stage. Turn zero creates a new Codex Thread and later Turns resume it. Repeating the request starts a new Stage attempt.
 * @tag Sessions
 * @pathParams SessionStageParams
 * @response 200:SessionStageRunResponse:Completed Stage execution
 * @add 400:ErrorResponse:Stage execution failed
 * @add 404:ErrorResponse:Session not found
 * @add 409:ErrorResponse:Session is already queued or running
 * @openapi
 */
export async function POST(_request: Request, context: RouteContext) {
  void _request;
  const { sessionId, stageIndex: stageIndexValue } = await context.params;
  const stageIndex = Number(stageIndexValue);
  if (!Number.isInteger(stageIndex) || stageIndex < 0) {
    return NextResponse.json(
      { error: `Invalid Stage index: ${stageIndexValue}` },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await runStage({ sessionId, stageIndex }));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: error instanceof RunStageError ? error.status : 400 },
    );
  }
}
