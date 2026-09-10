import { NextResponse } from "next/server";
import {
  createSessionGroupHumanConfirmedFindingsExport,
  findingMarkdownResponse,
} from "@/server/finding-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    groupId: string;
  }>;
};

/**
 * Export human-confirmed Session Group findings
 * @summary Export human-confirmed Session Group findings
 * @description Downloads explicitly human-confirmed Findings from every Group project as one Markdown document.
 * @tag Session Groups
 * @pathParams SessionGroupIdParams
 * @response 200:HumanConfirmedFindingsMarkdownResponse:Human-confirmed findings Markdown
 * @responseContentType text/markdown
 * @add 404:ErrorResponse:Session Group not found
 * @openapi
 */
export async function GET(_request: Request, context: RouteContext) {
  void _request;

  try {
    const { groupId } = await context.params;
    const markdownExport =
      await createSessionGroupHumanConfirmedFindingsExport(groupId);

    return findingMarkdownResponse(markdownExport);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}
