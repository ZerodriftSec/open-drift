import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";

import { POST as rerunSession } from "@/app/api/sessions/[sessionId]/rerun/route";
import { AuditSession } from "@/audit/session";
import { AuditStatus } from "@/audit/session/types";
import { getDb } from "@/server/db";
import {
  deleteSessionStateFromDb,
  getSessionQueue,
  readSessionStateFromDb,
} from "@/server/db/store";
import { sessionGroupMembers, sessionGroups } from "@/server/db/schema";
import {
  getDefaultWorkflowId,
  getWorkflowDefinition,
} from "@/server/workflows";
import { testAgent } from "./mock-agent";

test.each([AuditStatus.QUEUED, AuditStatus.RUNNING])(
  "rejects rerunning a %s session",
  async (status) => {
    const workflow = await getWorkflowDefinition(await getDefaultWorkflowId());
    const session = await AuditSession.createAuditSession({
      agents: workflow.stages.map(() => testAgent),
      initialStatus: status,
      projectName: `rerun-${status}`,
      targetPath: process.cwd(),
      workflow,
    });

    try {
      const response = await rerunSession(
        new Request(
          `http://localhost/api/sessions/${session.sessionId}/rerun`,
          {
            body: JSON.stringify({
              agentIds: workflow.stages.map(() => testAgent.id),
              workflowId: workflow.id,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
        { params: Promise.resolve({ sessionId: session.sessionId }) },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: `Session is queued or running and cannot be rerun: ${session.sessionId}`,
      });
      expect((await readSessionStateFromDb(session.sessionId))?.status).toBe(
        status,
      );
    } finally {
      await session.close();
      await deleteSessionStateFromDb(session.sessionId);
      await rm(session.sessionDirectoryPath, { force: true, recursive: true });
    }
  },
);

test("keeps a rerun session in its existing group", async () => {
  const workflow = await getWorkflowDefinition(await getDefaultWorkflowId());
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    initialStatus: AuditStatus.WAIT,
    projectName: "rerun-group-member",
    targetPath: process.cwd(),
    workflow,
  });
  const groupId = `group-${session.sessionId}`;
  const createdAt = new Date().toISOString();
  const db = await getDb();

  await db
    .insert(sessionGroups)
    .values({ createdAt, id: groupId, name: "Rerun group" })
    .run();
  await db
    .insert(sessionGroupMembers)
    .values({
      createdAt,
      groupId,
      index: 0,
      sessionId: session.sessionId,
    })
    .run();

  try {
    const response = await rerunSession(
      new Request(`http://localhost/api/sessions/${session.sessionId}/rerun`, {
        body: JSON.stringify({
          agentIds: workflow.stages.map(() => testAgent.id),
          workflowId: workflow.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ sessionId: session.sessionId }) },
    );

    expect(response.status).toBe(200);
    expect(
      await db
        .select()
        .from(sessionGroupMembers)
        .where(eq(sessionGroupMembers.sessionId, session.sessionId)),
    ).toEqual([
      expect.objectContaining({
        groupId,
        index: 0,
        sessionId: session.sessionId,
      }),
    ]);
  } finally {
    await getSessionQueue().removeSession(session.sessionId);
    await session.close();
    await deleteSessionStateFromDb(session.sessionId);
    await rm(session.sessionDirectoryPath, { force: true, recursive: true });
  }
});
