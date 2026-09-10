import { z } from "zod";
import { requestJson } from "@/app/components/lib/api-client";

const uploadArchiveResponseSchema = z
  .object({
    uploadId: z.string().min(1),
  })
  .passthrough();

const sessionCreateResponseSchema = z
  .object({
    id: z.string().optional(),
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();

export type CreatedSession = {
  message: string;
  redirectTo: string;
  sessionId: string;
};

type AgentAssignments = Record<string, string>;

export async function createUploadBackedSession(
  formData: FormData,
  agentAssignments: AgentAssignments,
): Promise<CreatedSession> {
  const run = formData.get("run") === "true";
  const archive = formData.get("archive");
  if (!(archive instanceof File)) {
    throw new Error("Select a ZIP archive.");
  }
  const workflowId = optionalFormString(formData.get("workflowId"));
  if (!workflowId) {
    throw new Error("Select a Workflow.");
  }

  const uploadForm = new FormData();
  uploadForm.set("archive", archive);
  uploadForm.set("workflowId", workflowId);
  const projectName = optionalFormString(formData.get("projectName"));
  if (projectName) {
    uploadForm.set("projectName", projectName);
  }

  const upload = await requestJson(
    "/api/session/upload",
    {
      body: uploadForm,
      method: "POST",
    },
    uploadArchiveResponseSchema,
    "Failed to upload project ZIP",
  );

  const session = await requestJson(
    "/api/sessions",
    {
      json: {
        ...sessionPayload(formData, agentAssignments, "upload"),
        uploadId: upload.uploadId,
      },
      method: "POST",
    },
    sessionCreateResponseSchema,
    "Failed to create audit task",
  );
  return createdSession(session, run);
}

export async function createLocalPathSession(
  formData: FormData,
  agentAssignments: AgentAssignments,
): Promise<CreatedSession> {
  const run = formData.get("run") === "true";

  const session = await requestJson(
    "/api/sessions",
    {
      json: sessionPayload(formData, agentAssignments, "local"),
      method: "POST",
    },
    sessionCreateResponseSchema,
    "Failed to create audit task",
  );
  return createdSession(session, run);
}

function sessionPayload(
  formData: FormData,
  agentAssignments: AgentAssignments,
  projectSource: "local" | "upload",
) {
  const excludedPaths = formData
    .getAll("excludedPaths")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    agentAssignments,
    ...(excludedPaths.length > 0 ? { excludedPaths } : {}),
    metadata: optionalJsonObject(formData.get("metadata")),
    projectName: optionalFormString(formData.get("projectName")),
    projectSource,
    queueSource: optionalFormString(formData.get("queueSource")),
    run: formData.get("run") === "true",
    ...(projectSource === "local"
      ? { source: optionalFormString(formData.get("source")) }
      : {}),
    workflowId: optionalFormString(formData.get("workflowId")),
  };
}

function optionalFormString(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function optionalJsonObject(value: FormDataEntryValue | null) {
  const text = optionalFormString(value);
  if (!text) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("metadata is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadata must be a JSON object.");
  }
  return parsed;
}

function createdSession(
  session: z.infer<typeof sessionCreateResponseSchema>,
  run: boolean,
) {
  const sessionId = session.session_id ?? session.sessionId ?? session.id;
  if (!sessionId) {
    throw new Error("The create endpoint did not return a sessionId.");
  }
  return {
    message: run ? "Audit task created and started" : "Audit task created",
    redirectTo: createdSessionHref(sessionId),
    sessionId,
  } satisfies CreatedSession;
}

function createdSessionHref(sessionId: string) {
  const params = new URLSearchParams({
    createdSessionId: sessionId,
    findingView: "ai-confirmed",
    view: "findings",
  });
  return `/sessions/${encodeURIComponent(sessionId)}?${params}`;
}
