import { NextResponse } from "next/server";
import {
  listCompatSessions,
  toCompatSessionCreateResponse,
} from "@/server/sessions/compat";
import { normalizeTaskMetadataWithSource } from "@/lib/task-metadata";
import { startUploadSessionFromUpload } from "@/server/uploads";
import { zerodriftApiErrorResponse } from "@/server/zerodrift/api-response";
import {
  getWorkflowDefinition,
  resolveWorkflowAgentId,
  type ResolvedWorkflowDefinition,
} from "@/server/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List audit sessions
 * @summary List audit sessions
 * @description ZeroDrift-compatible endpoint that returns paginated audit sessions.
 * @tag ZeroDrift Sessions
 * @params PaginationQueryParams
 * @response 200:CompatSessionsResponse:Paginated audit sessions
 * @add 400:ZerodriftApiErrorResponse:Invalid pagination request
 * @openapi
 */
export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const sessions = await listCompatSessions({
      page: numberParam(requestUrl.searchParams.get("page")),
      perPage: numberParam(
        requestUrl.searchParams.get("per_page") ??
          requestUrl.searchParams.get("pageSize"),
      ),
    });

    return NextResponse.json(sessions);
  } catch (error) {
    return zerodriftApiErrorResponse(error, { status: 400 });
  }
}

/**
 * Start audit session from upload
 * @summary Start audit session from upload
 * @description ZeroDrift-compatible endpoint that starts a queued audit session from a previously uploaded archive. Invalid Agent IDs fall back to the Workflow defaultModel; Workflows without a default reject them.
 * @tag ZeroDrift Sessions
 * @body CompatSessionCreateBody
 * @response 200:CompatSessionCreateResponse:Queued session metadata
 * @add 400:ZerodriftApiErrorResponse:Invalid session request
 * @openapi
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const projectSource = stringValue(
      body.project_source ?? body.projectSource,
    );
    const projectName = stringValue(body.project_name ?? body.projectName);
    const uploadId = stringValue(body.upload_id ?? body.uploadId);
    const excludedPaths = stringArrayValue(
      body.excluded_paths ?? body.excludedPaths,
    );
    const metadata = normalizeTaskMetadataWithSource(
      body.metadata,
      body.source ?? body.queue_source ?? body.queueSource,
    );
    const workflow = await getWorkflowDefinition(
      requiredString(body.workflowId ?? body.workflow_id, "workflowId"),
    );
    const agentIds = requiredAgentIds(
      body.agentIds ?? body.agent_ids,
      workflow,
    );

    if (projectSource && projectSource !== "upload") {
      return zerodriftApiErrorResponse(
        "The compatibility API currently supports only project_source=upload. Use the native audit-workbench batch API for local projects.",
        {
          code: "UNSUPPORTED_PROJECT_SOURCE",
          status: 400,
        },
      );
    }

    if (!uploadId) {
      return zerodriftApiErrorResponse("Missing upload_id", {
        code: "MISSING_UPLOAD_ID",
        status: 400,
      });
    }

    const result = await startUploadSessionFromUpload({
      agentIds,
      workflowId: workflow.id,
      excludedPaths,
      metadata,
      projectName: projectName || undefined,
      projectRoot: process.cwd(),
      uploadId,
    });

    return NextResponse.json(
      toCompatSessionCreateResponse(
        result.sessionId,
        "queued",
        result.projectName,
        result.source,
      ),
    );
  } catch (error) {
    return zerodriftApiErrorResponse(error, { status: 400 });
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(value: unknown, field: string) {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new Error(`Missing ${field}`);
  }
  return normalized;
}

function requiredAgentIds(
  value: unknown,
  workflow: ResolvedWorkflowDefinition,
) {
  if (!Array.isArray(value)) {
    throw new Error("agentIds must be an array of Agent IDs.");
  }

  const agentIds = value.map((agentId) =>
    resolveWorkflowAgentId(agentId, workflow),
  );

  if (agentIds.length !== workflow.stages.length) {
    throw new Error(
      `Workflow ${workflow.name} has ${workflow.stages.length} stages, so agentIds must contain ${workflow.stages.length} Agents.`,
    );
  }

  return agentIds;
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
