import { NextResponse } from "next/server";
import { listUploadTree } from "@/server/uploads";
import { zerodriftApiErrorResponse } from "@/server/zerodrift/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    uploadId: string;
  }>;
};

/**
 * List upload tree
 * @summary List upload tree
 * @description Lists files and directories under a stored upload extraction directory.
 * @tag ZeroDrift Uploads
 * @pathParams UploadIdParams
 * @params UploadTreeQueryParams
 * @response 200:UploadTreeResponse:Upload directory entries
 * @add 400:ZerodriftApiErrorResponse:Invalid upload or path
 * @openapi
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { uploadId } = await context.params;
    const url = new URL(request.url);
    const treePath = url.searchParams.get("path") ?? "";
    const entries = await listUploadTree({
      treePath,
      uploadId,
    });

    return NextResponse.json({
      entries,
      path: treePath,
      upload_id: uploadId,
      uploadId,
    });
  } catch (error) {
    return zerodriftApiErrorResponse(error, { status: 400 });
  }
}
