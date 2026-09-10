import { NextResponse } from "next/server";
import {
  createWorkflow,
  getDefaultWorkflowId,
  listWorkflowDefinitions,
} from "@/server/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List audit workflows
 * @summary List audit workflows
 * @description Returns built-in and .data/workflow JSON workflows with the default workflow ID.
 * @tag Workflows
 * @response 200:WorkflowsResponse:Saved audit workflows
 * @openapi
 */
export async function GET() {
  try {
    return NextResponse.json({
      workflows: await listWorkflowDefinitions(),
      defaultWorkflowId: await getDefaultWorkflowId(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

/**
 * Create a Workflow JSON document
 * @summary Create a Workflow JSON document
 * @description Validates and saves one complete Workflow JSON document under .data/workflow.
 * @tag Workflows
 * @body WorkflowDocumentInput
 * @response 200:WorkflowDocumentResponse:Created Workflow JSON document
 * @openapi
 */
export async function POST(request: Request) {
  try {
    return NextResponse.json(await createWorkflow(await request.json()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
