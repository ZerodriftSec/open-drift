import { rm } from "node:fs/promises";
import { expect, test } from "vitest";

import { POST as refreshSessionWorkflow } from "@/app/api/sessions/[sessionId]/workflow/refresh/route";
import { AuditSession } from "@/audit/session";
import {
  AuditStatus,
  type AuditStatus as AuditStatusValue,
} from "@/audit/session/types";
import { WorkflowDefinition } from "@/audit/workflow";
import {
  deleteSessionStateFromDb,
  readSessionStateFromDb,
} from "@/server/db/store";
import {
  getDefaultWorkflowId,
  getWorkflowDefinition,
} from "@/server/workflows";
import { testAgent } from "./mock-agent";

const refreshableStatuses = [
  AuditStatus.QUEUED,
  AuditStatus.COMPLETED,
  AuditStatus.FAILED,
  AuditStatus.INTERRUPTED,
  AuditStatus.WAIT,
] as const;

test.each(refreshableStatuses)(
  "refreshes the Workflow snapshot for a %s session",
  async (status) => {
    const { latestWorkflow, session } = await createOutdatedSession(status);

    try {
      const response = await callRefresh(session.sessionId);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sessionId: session.sessionId,
        workflow: latestWorkflow.toJSON(),
        workflowId: latestWorkflow.id,
      });
      const stored = await readSessionStateFromDb(session.sessionId);
      expect(stored?.status).toBe(status);
      expect(stored?.workflow.toJSON()).toEqual(latestWorkflow.toJSON());
    } finally {
      await cleanupSession(session);
    }
  },
);

test("rejects refreshing the Workflow snapshot for a running session", async () => {
  const { outdatedWorkflow, session } = await createOutdatedSession(
    AuditStatus.RUNNING,
  );

  try {
    const response = await callRefresh(session.sessionId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `Session is running and its Workflow snapshot cannot be updated: ${session.sessionId}`,
    });
    const stored = await readSessionStateFromDb(session.sessionId);
    expect(stored?.status).toBe(AuditStatus.RUNNING);
    expect(stored?.workflow.toJSON()).toEqual(outdatedWorkflow.toJSON());
  } finally {
    await cleanupSession(session);
  }
});

async function createOutdatedSession(status: AuditStatusValue) {
  const latestWorkflow = await getWorkflowDefinition(
    await getDefaultWorkflowId(),
  );
  const outdatedWorkflow = Object.assign(
    new WorkflowDefinition({
      name: latestWorkflow.name,
      stages: [
        {
          name: "Outdated Stage",
          turns: [{ prompt: "Outdated prompt" }],
        },
      ],
    }),
    { id: latestWorkflow.id },
  );
  const session = await AuditSession.createAuditSession({
    agents: [testAgent],
    initialStatus: status,
    projectName: `workflow-refresh-${status}`,
    targetPath: process.cwd(),
    workflow: outdatedWorkflow,
  });

  return { latestWorkflow, outdatedWorkflow, session };
}

function callRefresh(sessionId: string) {
  return refreshSessionWorkflow(
    new Request(`http://localhost/api/sessions/${sessionId}/workflow/refresh`, {
      method: "POST",
    }),
    { params: Promise.resolve({ sessionId }) },
  );
}

async function cleanupSession(session: AuditSession) {
  await session.close();
  await deleteSessionStateFromDb(session.sessionId);
  await rm(session.sessionDirectoryPath, { force: true, recursive: true });
}
