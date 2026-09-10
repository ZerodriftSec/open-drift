import { rm } from "node:fs/promises";
import { expect, test } from "vitest";

import { POST as dequeueSession } from "@/app/api/sessions/[sessionId]/dequeue/route";
import { createQueueStore } from "@/audit/queue";
import { modelProviderQueueKey } from "@/audit/queue/model-provider-key";
import { AuditSession } from "@/audit/session";
import { AuditStatus } from "@/audit/session/types";
import {
  deleteSessionStateFromDb,
  readSessionStateFromDb,
} from "@/server/db/store";
import { recoverStaleRuntimeState } from "@/server/runtime/cleanup";
import {
  getDefaultWorkflowId,
  getWorkflowDefinition,
} from "@/server/workflows";
import { testAgent } from "./mock-agent";

test("removes a queued session from the queue and changes it to wait", async () => {
  const { item, session } = await createTestSession(AuditStatus.QUEUED);
  const store = createQueueStore();
  await store.insert(item);

  try {
    const response = await callDequeue(session.sessionId);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: "Session was dequeued and is now waiting",
      removedQueueItems: 1,
      sessionId: session.sessionId,
      status: AuditStatus.WAIT,
    });
    expect((await readSessionStateFromDb(session.sessionId))?.status).toBe(
      AuditStatus.WAIT,
    );
    expect(await store.listItems()).not.toContainEqual(item);
  } finally {
    await cleanupSession(session, store);
  }
});

test("changes an unrecoverable queued session without a queue item to wait", async () => {
  const { session } = await createTestSession(AuditStatus.QUEUED);
  const store = createQueueStore();

  try {
    const response = await callDequeue(session.sessionId);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removedQueueItems: 0,
      status: AuditStatus.WAIT,
    });
    expect((await readSessionStateFromDb(session.sessionId))?.status).toBe(
      AuditStatus.WAIT,
    );
  } finally {
    await cleanupSession(session, store);
  }
});

test("rejects dequeue after the queue item has been claimed", async () => {
  const { item, session } = await createTestSession(AuditStatus.QUEUED);
  const store = createQueueStore();
  await store.insert(item);
  expect(await store.claim(item)).toEqual(item);

  try {
    const response = await callDequeue(session.sessionId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `Session has already been claimed by a Queue Worker and cannot be dequeued: ${session.sessionId}`,
    });
    expect((await readSessionStateFromDb(session.sessionId))?.status).toBe(
      AuditStatus.QUEUED,
    );
  } finally {
    await cleanupSession(session, store);
  }
});

test("dequeue is idempotent for a waiting session", async () => {
  const { session } = await createTestSession(AuditStatus.WAIT);
  const store = createQueueStore();

  try {
    const response = await callDequeue(session.sessionId);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: "Session is already waiting",
      removedQueueItems: 0,
      status: AuditStatus.WAIT,
    });
  } finally {
    await cleanupSession(session, store);
  }
});

test("startup recovery preserves queued sessions and requeues running sessions", async () => {
  const { item: queuedItem, session: queuedSession } = await createTestSession(
    AuditStatus.QUEUED,
  );
  const { item: runningItem, session: runningSession } =
    await createTestSession(AuditStatus.RUNNING);
  const store = createQueueStore();
  await store.insert(queuedItem);
  expect(await store.claim(queuedItem)).toEqual(queuedItem);

  try {
    await recoverStaleRuntimeState(process.cwd(), "test_restart");
    await recoverStaleRuntimeState(process.cwd(), "test_restart_again");

    expect(
      (await readSessionStateFromDb(queuedSession.sessionId))?.status,
    ).toBe(AuditStatus.QUEUED);
    expect(
      (await readSessionStateFromDb(runningSession.sessionId))?.status,
    ).toBe(AuditStatus.QUEUED);

    const recoveredItems = await store.listItems();
    expect(recoveredItems).toEqual(
      expect.arrayContaining([queuedItem, runningItem]),
    );
    expect(
      recoveredItems.filter(
        (item) =>
          item.sessionId === queuedSession.sessionId ||
          item.sessionId === runningSession.sessionId,
      ),
    ).toHaveLength(2);
  } finally {
    await cleanupSession(queuedSession, store);
    await cleanupSession(runningSession, store);
  }
});

async function createTestSession(initialStatus: AuditStatus) {
  const workflow = await getWorkflowDefinition(await getDefaultWorkflowId());
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    initialStatus,
    projectName: `dequeue-${initialStatus}`,
    targetPath: process.cwd(),
    workflow,
  });
  return {
    item: {
      key: modelProviderQueueKey(workflow.stages.map(() => testAgent.id)),
      sessionId: session.sessionId,
    },
    session,
  };
}

function callDequeue(sessionId: string) {
  return dequeueSession(
    new Request(`http://localhost/api/sessions/${sessionId}/dequeue`, {
      method: "POST",
    }),
    { params: Promise.resolve({ sessionId }) },
  );
}

async function cleanupSession(
  session: AuditSession,
  store: ReturnType<typeof createQueueStore>,
) {
  await store.deleteBySessionId(session.sessionId);
  await session.close();
  await deleteSessionStateFromDb(session.sessionId);
  await rm(session.sessionDirectoryPath, { force: true, recursive: true });
}
