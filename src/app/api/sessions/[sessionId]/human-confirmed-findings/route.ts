import { NextResponse } from "next/server";
import {
  createSessionHumanConfirmedFindingsExport,
  findingMarkdownResponse,
} from "@/server/finding-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Export human-confirmed session findings
 * @summary Export human-confirmed session findings
 * @description Downloads every explicitly human-confirmed Finding in the Session as Markdown.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @response 200:HumanConfirmedFindingsMarkdownResponse:Human-confirmed findings Markdown
 * @responseContentType text/markdown
 * @add 404:ErrorResponse:Session not found
 * @openapi
 */
export async function GET(_request: Request, context: RouteContext) {
  void _request;

  try {
    const { sessionId } = await context.params;
    const markdownExport =
      await createSessionHumanConfirmedFindingsExport(sessionId);

    return findingMarkdownResponse(markdownExport);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}
