import { NextResponse } from "next/server";
import {
  getWorkflowDefinition,
  resolveWorkflowAgentId,
  type ResolvedWorkflowDefinition,
} from "@/server/workflows";
import { listSessionPage } from "@/server/sessions";
import { addSessionToNamedGroup } from "@/server/session-groups";
import { normalizeTaskMetadataWithSource } from "@/lib/task-metadata";
import {
  createAndStartPathSession,
  startUploadSessionFromUpload,
} from "@/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List audit sessions
 * @summary List audit sessions
 * @description Returns paginated audit sessions using the native Agent/Workflow/Session contract.
 * @tag Sessions
 * @params PaginationQueryParams
 * @response 200:SessionsResponse:Paginated audit sessions
 * @openapi
 */
export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const sessions = await listSessionPage({
      page: numberParam(requestUrl.searchParams.get("page")),
      pageSize: numberParam(
        requestUrl.searchParams.get("per_page") ??
          requestUrl.searchParams.get("pageSize"),
      ),
    });

    return NextResponse.json(sessions);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }
}

/**
 * Create audit session
 * @summary Create audit session
 * @description Creates an audit session from a previously uploaded archive or a local project path, and optionally queues its Workflow. Invalid Agent IDs fall back to the Workflow defaultModel; Workflows without a default reject them.
 * @tag Sessions
 * @body SessionCreateBody
 * @response 200:SessionCreateResponse:Created session metadata
 * @openapi
 */
export async function POST(request: Request) {
  try {
    const body = jsonObjectValue(await request.json(), "body");
    const projectSource = requiredString(body.projectSource, "projectSource");
    const projectName = stringValue(body.projectName);
    const groupName = stringValue(body.groupName);
    const metadata = normalizeTaskMetadataWithSource(
      body.metadata,
      body.queueSource,
    );
    const excludedPaths = stringArrayValue(body.excludedPaths);
    const run = requiredBoolean(body.run, "run");
    const workflow = await getWorkflowDefinition(
      requiredString(body.workflowId, "workflowId"),
    );
    const agents = await requiredAgentAssignments(
      body.agentAssignments,
      workflow,
    );

    if (projectSource === "local") {
      const result = await createAndStartPathSession({
        agentIds: agents.agentIds,
        workflowId: workflow.id,
        metadata,
        projectName: projectName || undefined,
        projectRoot: process.cwd(),
        run,
        targetPath: requiredString(body.source, "source"),
      });

      return NextResponse.json(
        await nativeSessionCreateResponse({
          agentAssignments: agents.agentAssignments,
          groupName,
          result,
          run,
          workflow,
        }),
      );
    }

    if (projectSource !== "upload") {
      return NextResponse.json(
        {
          error: "This API supports only projectSource=upload or local.",
        },
        { status: 400 },
      );
    }

    const result = await startUploadSessionFromUpload({
      agentIds: agents.agentIds,
      workflowId: workflow.id,
      excludedPaths,
      metadata,
      projectName: projectName || undefined,
      projectRoot: process.cwd(),
      run,
      uploadId: requiredString(body.uploadId, "uploadId"),
    });

    return NextResponse.json(
      await nativeSessionCreateResponse({
        agentAssignments: agents.agentAssignments,
        groupName,
        result,
        run,
        workflow,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }
}

async function nativeSessionCreateResponse({
  agentAssignments,
  groupName,
  result,
  run,
  workflow,
}: {
  agentAssignments: Record<string, string>;
  groupName: string;
  result: {
    sessionId: string;
    projectName: string;
  };
  run: boolean;
  workflow: ResolvedWorkflowDefinition;
}) {
  const group = groupName
    ? await addSessionToNamedGroup({ groupName, sessionId: result.sessionId })
    : undefined;
  return {
    agentAssignments,
    ...(group ? { groupId: group.groupId, groupName: group.groupName } : {}),
    sessionId: result.sessionId,
    workflowId: workflow.id,
    status: run ? "queued" : "wait",
    projectName: result.projectName,
  };
}

async function requiredAgentAssignments(
  value: unknown,
  workflow: ResolvedWorkflowDefinition,
) {
  const assignments = jsonObjectValue(value, "agentAssignments");
  const stageIds = [...workflow.stageIds];
  const expectedStageIds = new Set(stageIds);
  const providedStageIds = Object.keys(assignments);
  if (
    providedStageIds.length !== stageIds.length ||
    providedStageIds.some((stageId) => !expectedStageIds.has(stageId))
  ) {
    throw new Error(
      "agentAssignments must assign one Agent to every stable Workflow Stage ID.",
    );
  }

  const agentAssignments = Object.fromEntries(
    stageIds.map((stageId) => [
      stageId,
      resolveWorkflowAgentId(assignments[stageId], workflow),
    ]),
  );
  return {
    agentAssignments,
    agentIds: stageIds.map((stageId) => agentAssignments[stageId]!),
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(value: unknown, field: string) {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(`Missing ${field}`);
  return normalized;
}

function requiredBoolean(value: unknown, field: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function jsonObjectValue(value: unknown, field: string) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error(`${field} is not a valid JSON object.`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function stringArrayValue(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function numberParam(value: string | null) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
