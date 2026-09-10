import { NextResponse } from "next/server";
import { listSessionArtifactTree } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * List session artifact tree
 * @summary List session artifact tree
 * @description Lists files and directories under the audit session artifact directory.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @params SessionArtifactTreeQueryParams
 * @response 200:SessionArtifactTreeResponse:Session artifact directory entries
 * @add 404:ErrorResponse:Session artifacts not found
 * @openapi
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const treePath = url.searchParams.get("path") ?? "";
    const entries = await listSessionArtifactTree({
      projectRoot: process.cwd(),
      sessionId,
      treePath,
    });

    return NextResponse.json({
      entries,
      path: treePath,
      session_id: sessionId,
      sessionId,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}
