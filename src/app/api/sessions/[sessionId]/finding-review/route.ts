import { NextResponse, type NextRequest } from "next/server";
import {
  reviewSessionFinding,
  type HumanFindingReviewAction,
} from "@/server/sessions";
import { sessionPagePath } from "@/lib/page-routes";
import { findingReviewUpdateSchema } from "@/schemas/finding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Review session finding
 * @summary Review session finding
 * @description UI form endpoint that confirms a finding as true or false, or resets the human review, then redirects back to the findings view.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @body FindingReviewFormBody
 * @contentType application/x-www-form-urlencoded
 * @response 200:FindingReviewResponse:Updated finding review state for JSON clients
 * @add 303:RedirectResponse:Redirects back to the session findings view
 * @responseHeader 303 Location string Redirect target URL
 * @openapi
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  try {
    const { action, findingId } = findingReviewUpdateSchema.parse(
      await readReviewRequest(request),
    );

    const result = await reviewSessionFinding({
      action,
      findingId,
      sessionId,
    });
    const findingView = targetFindingView(action, result.source);

    const redirectUrl = new URL(sessionPagePath(sessionId), request.url);
    redirectUrl.searchParams.set("view", "findings");
    redirectUrl.searchParams.set("findingView", findingView);

    if (wantsJson(request)) {
      return NextResponse.json({
        action,
        findingKey: result.findingKey,
        findingView,
        humanStatus: result.finding.human_status ?? null,
        message: reviewActionMessage(action),
        redirectTo: `${sessionPagePath(sessionId)}?view=findings&findingView=${findingView}`,
        review: action === "reset" ? null : result.review,
        sessionId,
        source: result.source,
      });
    }

    return NextResponse.redirect(redirectUrl, 303);
  } catch (error) {
    if (wantsJson(request)) {
      return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
    }

    const redirectUrl = new URL(sessionPagePath(sessionId), request.url);
    redirectUrl.searchParams.set("view", "findings");
    redirectUrl.searchParams.set("findingReviewError", errorMessage(error));

    return NextResponse.redirect(redirectUrl, 303);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readReviewRequest(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return {
      action: body.action,
      findingId:
        typeof body.findingId === "number" || typeof body.findingId === "string"
          ? body.findingId
          : null,
    };
  }

  const formData = await request.formData();
  return {
    action: formData.get("action"),
    findingId:
      typeof formData.get("findingId") === "string"
        ? (formData.get("findingId") as string)
        : null,
  };
}

function reviewActionMessage(action: HumanFindingReviewAction) {
  if (action === "confirm") return "Finding confirmed as valid";
  if (action === "pass") return "Finding confirmed as invalid";
  return "Manual review cleared";
}

function targetFindingView(
  action: HumanFindingReviewAction,
  source: "confirmed" | "pending",
) {
  if (action === "confirm") return "human-confirmed";
  if (action === "pass") return "human-rejected";
  if (source === "pending") return "pending";
  return "ai-confirmed";
}

function wantsJson(request: NextRequest) {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}
