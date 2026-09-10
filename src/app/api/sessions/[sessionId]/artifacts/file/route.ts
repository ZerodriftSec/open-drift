import { NextResponse } from "next/server";
import { readSessionArtifactFile } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Read session artifact file
 * @summary Read session artifact file
 * @description Reads a UTF-8 text file from the audit session artifact directory.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @params SessionArtifactFileQueryParams
 * @response 200:SessionArtifactFileResponse:Session artifact file content
 * @add 404:ErrorResponse:Session artifact file not found
 * @openapi
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path") ?? "";
    const file = await readSessionArtifactFile({
      filePath,
      projectRoot: process.cwd(),
      sessionId,
    });

    return NextResponse.json({
      ...file,
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
