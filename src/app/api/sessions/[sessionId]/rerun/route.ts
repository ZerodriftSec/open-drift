import {
  getWorkflowDefinition,
  type ResolvedWorkflowDefinition,
  workflowStageIds,
} from "@/server/workflows";
import { WorkflowDefinition } from "@/audit/workflow";
import { normalizeAgentId } from "@/audit/agent/registry";
import { sessionPagePath } from "@/lib/page-routes";
import type { TaskMetadata } from "@/lib/task-metadata";
import {
  getSessionDetails,
  type AuditSessionSnapshot,
} from "@/server/sessions";
import { rerunPathSessionInPlace } from "@/server/uploads";
import { AuditStatus } from "@/audit/session/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

/**
 * Rerun session
 * @summary Rerun session
 * @description Archives an inactive session directory, clears the original session state, and reruns the same session ID from the original target path.
 * @tag Sessions
 * @pathParams SessionIdParams
 * @body SessionRerunBody
 * @response 200:SessionRerunResponse:Rerun session metadata
 * @add 400:ErrorResponse:Session rerun failed
 * @add 404:ErrorResponse:Session not found
 * @add 409:ErrorResponse:Session is queued or running
 * @openapi
 */
export async function POST(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;

  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const details = await getSessionDetails(sessionId, process.cwd());
    if (!details) {
      return NextResponse.json(
        { error: `Session not found: ${sessionId}` },
        { status: 404 },
      );
    }
    if (
      details.state.status === AuditStatus.QUEUED ||
      details.state.status === AuditStatus.RUNNING
    ) {
      return NextResponse.json(
        {
          error: `Session is queued or running and cannot be rerun: ${sessionId}`,
        },
        { status: 409 },
      );
    }

    const requestedWorkflowId = stringValue(body.workflowId);
    const workflow = requestedWorkflowId
      ? await getWorkflowDefinition(requestedWorkflowId)
      : Object.assign(new WorkflowDefinition(details.state.workflow.toJSON()), {
          id: details.state.workflowId,
          stageIds: workflowStageIds(
            details.state.workflowId,
            details.state.workflow.stages.length,
          ),
        });
    const agentIds = requiredAgentIds(body.agentIds, workflow);
    const result = await rerunPathSessionInPlace({
      agentIds,
      workflow,
      workflowId: workflow.id,
      metadata: rerunMetadata(details.state),
      originalCreatedAt: details.state.createdAt,
      projectName: details.state.projectName,
      projectRoot: process.cwd(),
      sessionId,
      targetPath: details.state.targetPath,
    });

    const redirectTo = `${sessionPagePath(sessionId)}?view=findings&findingView=ai-confirmed`;

    return NextResponse.json({
      agentIds,
      workflowId: workflow.id,
      backupDir: result.backupDir,
      message: "Session cleared and rerun",
      redirectTo,
      sessionId,
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

function rerunMetadata(state: AuditSessionSnapshot): TaskMetadata | undefined {
  const metadata: TaskMetadata =
    state.metadata &&
    typeof state.metadata === "object" &&
    !Array.isArray(state.metadata)
      ? { ...state.metadata }
      : {};
  if (state.source) {
    metadata.source = state.source;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredAgentIds(
  value: unknown,
  workflow: ResolvedWorkflowDefinition,
) {
  if (!Array.isArray(value)) {
    throw new Error("agentIds must be an array of Agent IDs.");
  }

  const agentIds = value.map((agentId) => {
    const normalized = stringValue(agentId);
    if (!normalized) {
      throw new Error("agentIds cannot contain empty values.");
    }
    return normalizeAgentId(normalized);
  });

  if (agentIds.length !== workflow.stages.length) {
    throw new Error(
      `Workflow ${workflow.name} has ${workflow.stages.length} stages, so agentIds must contain ${workflow.stages.length} Agents.`,
    );
  }

  return agentIds;
}
