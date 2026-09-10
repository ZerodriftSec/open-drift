import { NextResponse, type NextRequest } from "next/server";
import { sessionPagePath } from "@/lib/page-routes";
import { findingNoteFormSchema } from "@/schemas/finding";
import { updateSessionFindingNote } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update session finding note
 * @summary Update session finding note
 * @description Saves or clears the human-authored note attached to a persisted finding.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @body FindingNoteFormBody
 * @contentType application/x-www-form-urlencoded
 * @response 200:FindingNoteResponse:Updated finding note
 * @add 400:ErrorResponse:Invalid note or finding
 * @openapi
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  try {
    const input = findingNoteFormSchema.parse(await readNoteRequest(request));
    const finding = await updateSessionFindingNote({
      findingId: input.findingId,
      note: input.note,
      sessionId,
    });
    const findingView = input.findingView ?? "ai-confirmed";
    const redirectTo = `${sessionPagePath(sessionId)}?view=findings&findingView=${findingView}`;

    if (wantsJson(request)) {
      return NextResponse.json({
        finding,
        message: input.note ? "Finding note saved" : "Finding note cleared",
        redirectTo,
        sessionId,
      });
    }

    return NextResponse.redirect(new URL(redirectTo, request.url), 303);
  } catch (error) {
    if (wantsJson(request)) {
      return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
    }

    const redirectUrl = new URL(sessionPagePath(sessionId), request.url);
    redirectUrl.searchParams.set("view", "findings");
    redirectUrl.searchParams.set("findingView", "ai-confirmed");
    redirectUrl.searchParams.set("findingReviewError", errorMessage(error));
    return NextResponse.redirect(redirectUrl, 303);
  }
}

async function readNoteRequest(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
    : Object.fromEntries(await request.formData());

  return {
    findingId: body.findingId,
    findingView:
      typeof body.findingView === "string" && body.findingView !== ""
        ? body.findingView
        : undefined,
    note: typeof body.note === "string" ? body.note : "",
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wantsJson(request: NextRequest) {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}
