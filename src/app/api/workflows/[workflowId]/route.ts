import { NextResponse } from "next/server";
import {
  deleteWorkflow,
  getWorkflowDocument,
  saveWorkflow,
} from "@/server/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ workflowId: string }> };

/**
 * Get a Workflow JSON document
 * @summary Get a Workflow JSON document
 * @tag Workflows
 * @pathParams WorkflowIdParams
 * @response 200:WorkflowDocumentResponse:Workflow JSON document
 * @openapi
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { workflowId } = await context.params;
    void request;
    return NextResponse.json(await getWorkflowDocument(workflowId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}

/**
 * Delete Workflow
 * @summary Delete a Workflow
 * @description Permanently deletes a custom Workflow JSON file. Built-in Workflows are read-only and existing Sessions retain their frozen snapshots.
 * @tag Workflows
 * @pathParams WorkflowIdParams
 * @response 200:WorkflowDeleteResponse:Deleted Workflow
 * @openapi
 */
export async function DELETE(_request: Request, context: RouteContext) {
  void _request;
  try {
    const { workflowId } = await context.params;
    await deleteWorkflow(workflowId);
    return NextResponse.json({ workflowId, deleted: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

/**
 * Save a Workflow JSON document
 * @summary Save a Workflow JSON document
 * @description Validates and atomically replaces a custom Workflow JSON file.
 * @tag Workflows
 * @pathParams WorkflowIdParams
 * @body WorkflowDocumentInput
 * @response 200:WorkflowDocumentResponse:Saved Workflow JSON document
 * @openapi
 */
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { workflowId } = await context.params;
    return NextResponse.json(
      await saveWorkflow(workflowId, await request.json()),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
