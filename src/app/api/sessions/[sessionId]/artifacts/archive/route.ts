import { NextResponse } from "next/server";
import { createSessionArtifactArchive } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const treePath = url.searchParams.get("path") ?? "";
    const archive = await createSessionArtifactArchive({
      projectRoot: process.cwd(),
      sessionId,
      treePath,
    });

    return new Response(archive.stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": contentDispositionAttachment(archive.fileName),
        "Content-Type": archive.mimeType,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}

function contentDispositionAttachment(fileName: string) {
  const fallbackName = fileName.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
