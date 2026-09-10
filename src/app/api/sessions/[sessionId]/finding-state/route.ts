import { NextResponse, type NextRequest } from "next/server";
import { findingStateQuerySchema } from "@/schemas/finding";
import { getSessionFindingState } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Get finding interaction state
 * @summary Get finding interaction state
 * @description Returns the latest human TP/FP review and note for one persisted finding.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @queryParams FindingStateQueryParams
 * @response 200:FindingStateResponse:Latest finding interaction state
 * @add 400:ErrorResponse:Invalid or missing finding
 * @openapi
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;
    const query = findingStateQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );

    return NextResponse.json(
      await getSessionFindingState({
        ...query,
        sessionId,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
