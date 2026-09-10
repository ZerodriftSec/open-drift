import { File } from "node:buffer";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { expect, test, vi } from "vitest";

import { GET as getApiDocs } from "@/app/api-docs/route";
import { POST as uploadSessionProject } from "@/app/api/session/upload/route";
import {
  POST as createSession,
  GET as listSessions,
} from "@/app/api/sessions/route";
import { DELETE as deleteSession } from "@/app/api/sessions/[sessionId]/route";
import { GET as getSessionStatus } from "@/app/api/sessions/[sessionId]/status/route";
import { DELETE as deleteWorkflowRoute } from "@/app/api/workflows/[workflowId]/route";
import { listAgentDefinitions } from "@/audit/agent/registry";
import "@/audit/runner-consumer";
import { AuditStatus } from "@/audit/session/types";
import {
  createWorkflow,
  deleteWorkflow,
  getDefaultWorkflowId,
  getWorkflowDefinition,
  getWorkflowDocument,
} from "@/server/workflows";
import { testAgent } from "./mock-agent";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workflow = await getWorkflowDefinition(await getDefaultWorkflowId());
const archiveContents = Buffer.from(
  "UEsDBBQAAAAIAC8Q8lx8ujOeFAAAABIAAAAJAAAAVmF1bHQuc29sS87PKylKTC5RCEsszSlRqK7lAgBQSwECFAMUAAAACAAvEPJcfLoznhQAAAASAAAACQAAAAAAAAAAAAAAgAEAAAAAVmF1bHQuc29sUEsFBgAAAAABAAEANwAAADsAAAAAAA==",
  "base64",
);

async function testAgentAssignments() {
  const agentId = listAgentDefinitions()[0]!.id;
  return Object.fromEntries(
    workflow.stageIds.map((stageId) => [stageId, agentId]),
  );
}

test("the API docs expose separate session upload and creation endpoints", async () => {
  const response = await getApiDocs();
  const spec = JSON.parse(
    await readFile(path.join(projectRoot, "public", "openapi.json"), "utf8"),
  ) as {
    components: {
      schemas: Record<
        string,
        | {
            properties?: Record<string, unknown>;
            required?: string[];
          }
        | undefined
      >;
    };
    paths: Record<string, Record<string, unknown>>;
  };

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(await response.text()).toContain("/openapi.json");
  expect(spec.paths["/api/upload"]).toBeUndefined();
  expect(spec.paths["/api/session/upload"]?.post).toBeDefined();
  expect(spec.paths["/api/sessions"]?.post).toBeDefined();
  expect(spec.paths["/api/session-groups/{groupId}"]?.delete).toBeDefined();
  expect(spec.paths["/api/session-groups/{groupId}"]?.patch).toBeDefined();
  expect(spec.paths["/api/workflows/{workflowId}"]?.delete).toBeDefined();
  expect(spec.paths["/api/stages"]).toBeUndefined();
  expect(spec.paths["/api/stages/{stageId}"]).toBeUndefined();
  expect(spec.paths["/api/workflows/{workflowId}/stages"]).toBeUndefined();
  expect(spec.paths["/api/workflows/{workflowId}/restore"]).toBeUndefined();
  expect(spec.paths["/api/sessions/{sessionId}/status"]?.get).toBeDefined();
  expect(
    spec.components.schemas.AuditSessionSnapshot?.properties
      ?.aiConfirmedFindingCount,
  ).toBeDefined();
  expect(
    spec.components.schemas.SessionCreateUploadBody?.properties?.uploadId,
  ).toBeDefined();
  expect(
    spec.components.schemas.SessionCreateUploadBody?.properties
      ?.agentAssignments,
  ).toBeDefined();
  expect(
    spec.components.schemas.WorkflowDocumentInput?.properties?.defaultModel,
  ).toBeDefined();
  expect(
    spec.components.schemas.WorkflowDefinitionSummary?.properties?.defaultModel,
  ).toBeDefined();
  expect(
    spec.components.schemas.SessionCreateUploadBody?.properties?.groupName,
  ).toBeDefined();
  expect(
    spec.components.schemas.SessionGroupDetailsResponse?.properties
      ?.reviewMinSeverity,
  ).toBeDefined();
  expect(
    spec.components.schemas.SessionCreateResponse?.properties?.groupId,
  ).toBeDefined();
  expect(
    spec.components.schemas.SessionCreateLocalBody?.properties?.source,
  ).toBeDefined();
  expect(
    spec.components.schemas.SessionUploadBody?.properties?.archive,
  ).toBeDefined();
});

test("the upload and session routes run a ZIP project in two requests", async () => {
  const uploadForm = new FormData();
  uploadForm.set(
    "archive",
    new File([archiveContents], "vault.zip", {
      type: "application/zip",
    }) as unknown as Blob,
  );
  uploadForm.set("projectName", "API E2E Vault");
  uploadForm.set("workflowId", workflow.id);

  let sessionId: string | undefined;
  let uploadDir: string | undefined;

  try {
    const uploadResponse = await uploadSessionProject(
      new NextRequest("http://localhost/api/session/upload", {
        body: uploadForm,
        method: "POST",
      }),
    );
    const upload = (await uploadResponse.json()) as {
      projectName: string;
      uploadId: string;
    };
    uploadDir = path.join(process.cwd(), ".data", "upload", upload.uploadId);

    expect(uploadResponse.status).toBe(200);
    expect(upload.projectName).toBe("API E2E Vault");

    const sessionResponse = await createSession(
      new Request("http://localhost/api/sessions", {
        body: JSON.stringify({
          agentAssignments: await testAgentAssignments(),
          projectName: "API E2E Vault",
          projectSource: "upload",
          run: true,
          uploadId: upload.uploadId,
          workflowId: workflow.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const session = (await sessionResponse.json()) as {
      sessionId: string;
      status: string;
      workflowId: string;
    };
    sessionId = session.sessionId;

    expect(sessionResponse.status).toBe(200);
    expect(session.status).toBe(AuditStatus.QUEUED);
    expect(session.workflowId).toBe(workflow.id);

    await vi.waitFor(async () => {
      const statusResponse = await getSessionStatus(
        new Request(`http://localhost/api/sessions/${sessionId}/status`),
        { params: Promise.resolve({ sessionId: sessionId! }) },
      );
      const status = (await statusResponse.json()) as {
        status: string;
        targetPath: string;
      };

      expect(statusResponse.status).toBe(200);
      expect(status.status).toBe(AuditStatus.COMPLETED);
      expect(status.targetPath.startsWith(uploadDir!)).toBe(true);
    });

    const sessionsResponse = await listSessions(
      new Request("http://localhost/api/sessions?page=1&pageSize=10"),
    );
    const sessions = (await sessionsResponse.json()) as {
      items: Array<{ sessionId: string }>;
    };

    expect(sessionsResponse.status).toBe(200);
    expect(sessions.items.some((item) => item.sessionId === sessionId)).toBe(
      true,
    );
    expect(testAgent.newThread).toHaveBeenCalledTimes(
      workflow.stages.filter((stage) => stage.threadMode === "new").length,
    );
    expect(testAgent.resumeThread).toHaveBeenCalledTimes(
      workflow.stages.reduce(
        (total, stage) =>
          total +
          (stage.threadMode === "resume"
            ? stage.turns.length
            : Math.max(stage.turns.length - 1, 0)),
        0,
      ),
    );

    const deleteResponse = await deleteSession(
      new Request(`http://localhost/api/sessions/${sessionId}`),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(deleteResponse.status).toBe(200);
    sessionId = undefined;
  } finally {
    if (sessionId) {
      await deleteSession(
        new Request(`http://localhost/api/sessions/${sessionId}`),
        { params: Promise.resolve({ sessionId }) },
      );
    }
    if (uploadDir) {
      await rm(uploadDir, { force: true, recursive: true });
    }
  }
});

test("the session route creates a local project from the unified source field", async () => {
  const response = await createSession(
    new Request("http://localhost/api/sessions", {
      body: JSON.stringify({
        agentAssignments: await testAgentAssignments(),
        projectName: "API E2E Local",
        projectSource: "local",
        run: false,
        source: projectRoot,
        workflowId: workflow.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const session = (await response.json()) as {
    agentAssignments: Record<string, string>;
    sessionId: string;
    status: string;
  };

  expect(response.status).toBe(200);
  expect(session.status).toBe(AuditStatus.WAIT);
  expect(session.agentAssignments).toEqual(await testAgentAssignments());

  const deleteResponse = await deleteSession(
    new Request(`http://localhost/api/sessions/${session.sessionId}`),
    { params: Promise.resolve({ sessionId: session.sessionId }) },
  );
  expect(deleteResponse.status).toBe(200);
});

test("the session create POST falls back invalid models to the Workflow default", async () => {
  const defaultModel = listAgentDefinitions()[0]!.id;
  const createdWorkflow = await createWorkflow({
    defaultModel,
    name: "API E2E Default Model Workflow",
    stages: [
      {
        name: "Only Stage",
        dependsOn: [],
        threadMode: "new",
        turns: [{ prompt: "Audit the project." }],
      },
    ],
  });
  const defaultModelWorkflow = await getWorkflowDefinition(createdWorkflow.id);
  let sessionId: string | undefined;

  try {
    const response = await createSession(
      new Request("http://localhost/api/sessions", {
        body: JSON.stringify({
          agentAssignments: Object.fromEntries(
            defaultModelWorkflow.stageIds.map((stageId) => [
              stageId,
              "missing-agent",
            ]),
          ),
          projectName: "API E2E Default Model",
          projectSource: "local",
          run: false,
          source: projectRoot,
          workflowId: defaultModelWorkflow.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const session = (await response.json()) as {
      agentAssignments: Record<string, string>;
      error?: string;
      sessionId: string;
    };
    sessionId = session.sessionId;

    expect(response.status, session.error).toBe(200);
    expect(session.agentAssignments).toEqual(
      Object.fromEntries(
        defaultModelWorkflow.stageIds.map((stageId) => [
          stageId,
          defaultModelWorkflow.defaultModel,
        ]),
      ),
    );
  } finally {
    if (sessionId) {
      await deleteSession(
        new Request(`http://localhost/api/sessions/${sessionId}`),
        { params: Promise.resolve({ sessionId }) },
      );
    }
    await deleteWorkflow(createdWorkflow.id);
  }
});

test("the session create POST rejects invalid models without a Workflow default", async () => {
  const response = await createSession(
    new Request("http://localhost/api/sessions", {
      body: JSON.stringify({
        agentAssignments: Object.fromEntries(
          workflow.stageIds.map((stageId) => [stageId, "missing-agent"]),
        ),
        projectSource: "local",
        run: false,
        source: projectRoot,
        workflowId: workflow.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const body = (await response.json()) as { error: string };

  expect(response.status).toBe(400);
  expect(body.error).toContain("Invalid agent: missing-agent");
});

test("the session route rejects the removed agentIds field", async () => {
  const response = await createSession(
    new Request("http://localhost/api/sessions", {
      body: JSON.stringify({
        agentIds: [listAgentDefinitions()[0]!.id],
        projectSource: "local",
        run: false,
        source: projectRoot,
        workflowId: workflow.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const body = (await response.json()) as { error: string };

  expect(response.status).toBe(400);
  expect(body.error).toContain("agentAssignments");
});

test("the Workflow DELETE route permanently deletes a Workflow", async () => {
  const workflow = await createWorkflow({
    name: "API delete Workflow",
    stages: [
      {
        name: "Only Stage",
        dependsOn: [],
        threadMode: "new",
        turns: [{ prompt: "Run" }],
      },
    ],
  });
  const workflowId = workflow.id;

  const response = await deleteWorkflowRoute(
    new Request(`http://localhost/api/workflows/${workflowId}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ workflowId }) },
  );
  const body = (await response.json()) as {
    deleted: boolean;
    workflowId: string;
  };

  expect(response.status).toBe(200);
  expect(body).toEqual({ deleted: true, workflowId });
  await expect(getWorkflowDocument(workflowId)).rejects.toThrow("not found");
});
