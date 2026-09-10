import { File } from "node:buffer";
import { NextResponse, type NextRequest } from "next/server";
import { createUploadArchive } from "@/server/uploads";
import { zerodriftApiErrorResponse } from "@/server/zerodrift/api-response";
import { getWorkflowDefinition } from "@/server/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload project archive
 * @summary Upload project archive
 * @description ZeroDrift-compatible upload endpoint that stores a ZIP archive and returns upload metadata for a later session start.
 * @tag ZeroDrift Uploads
 * @body CompatUploadArchiveFormBody
 * @contentType multipart/form-data
 * @response 200:UploadArchiveResponse:Stored upload metadata
 * @add 400:ZerodriftApiErrorResponse:Upload validation error
 * @openapi
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const archive = readArchive(formData);
    const workflowId = await readWorkflowId(formData.get("workflowId"));
    const projectName = readProjectName(formData);
    const upload = await createUploadArchive({
      workflowId,
      archive,
      projectName,
      projectRoot: process.cwd(),
    });

    return NextResponse.json({
      archive_hash: upload.archiveHash,
      archiveHash: upload.archiveHash,
      project_name: upload.projectName,
      projectName: upload.projectName,
      upload_id: upload.uploadId,
      uploadId: upload.uploadId,
    });
  } catch (error) {
    return zerodriftApiErrorResponse(error, { status: 400 });
  }
}

async function readWorkflowId(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Missing workflowId");
  }
  return (await getWorkflowDefinition(value.trim())).id;
}

function readArchive(formData: FormData) {
  const archive = formData.get("file") ?? formData.get("archive");

  if (!(archive instanceof File)) {
    throw new Error("Select a ZIP archive.");
  }

  return archive;
}

function readProjectName(formData: FormData) {
  const value = formData.get("project_name") ?? formData.get("projectName");
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
