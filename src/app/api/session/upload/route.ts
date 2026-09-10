import { File } from "node:buffer";
import { NextResponse, type NextRequest } from "next/server";
import { getWorkflowDefinition } from "@/server/workflows";
import { createUploadArchive } from "@/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload a project archive for a session
 * @summary Upload session project
 * @description Stores a ZIP archive and returns an upload ID for a later session creation request.
 * @tag Sessions
 * @body SessionUploadBody
 * @contentType multipart/form-data
 * @response 200:SessionUploadResponse:Stored upload metadata
 * @openapi
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const archive = formData.get("archive");
    if (!(archive instanceof File)) {
      throw new Error("Select a ZIP archive.");
    }

    const workflowId = requiredFormString(formData, "workflowId");
    const workflow = await getWorkflowDefinition(workflowId);
    const upload = await createUploadArchive({
      workflowId: workflow.id,
      archive,
      projectName: optionalFormString(formData.get("projectName")),
      projectRoot: process.cwd(),
    });

    return NextResponse.json({
      archiveHash: upload.archiveHash,
      projectName: upload.projectName,
      uploadId: upload.uploadId,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }
}

function requiredFormString(formData: FormData, field: string) {
  const value = optionalFormString(formData.get(field));
  if (!value) {
    throw new Error(`Missing ${field}`);
  }
  return value;
}

function optionalFormString(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
