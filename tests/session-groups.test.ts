import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import {
  AuditStatus,
  HumanFindingStatus,
  Severity,
} from "@/audit/session/types";
import { getDb } from "@/server/db";
import {
  auditSessions,
  SessionFindingStatus,
  sessionFindings,
  sessionQueueItems,
  sessionGroupMembers,
  sessionGroups,
} from "@/server/db/schema";
import {
  addSessionToNamedGroup,
  deleteSessionGroup,
  getSessionReviewMinSeverity,
  getSessionGroup,
  listSessionGroupHierarchyPage,
  listSessionGroupMemberPage,
  updateSessionGroupReviewMinSeverity,
} from "@/server/session-groups";

test("adds Sessions to one reusable exact-name Group", async () => {
  const groupName = `onchain-token-${randomUUID()}`;
  const first = await createStoredSession(AuditStatus.WAIT);
  const second = await createStoredSession(AuditStatus.COMPLETED);

  const firstAssignment = await addSessionToNamedGroup({
    groupName,
    sessionId: first.sessionId,
  });
  const secondAssignment = await addSessionToNamedGroup({
    groupName,
    sessionId: second.sessionId,
  });

  expect(secondAssignment.groupId).toBe(firstAssignment.groupId);
  expect([firstAssignment.index, secondAssignment.index]).toEqual([0, 1]);
  await expect(getSessionGroup(firstAssignment.groupId)).resolves.toMatchObject(
    {
      groupId: firstAssignment.groupId,
      groupName,
      sessions: [
        { index: 0, session: { sessionId: first.sessionId } },
        { index: 1, session: { sessionId: second.sessionId } },
      ],
    },
  );

  await deleteSessionGroup({ groupId: firstAssignment.groupId });
});

test("paginates Group Sessions newest first without embedding them in the summary", async () => {
  const groupId = `group-${randomUUID()}`;
  const older = await createStoredSession(
    AuditStatus.COMPLETED,
    "2026-01-01T00:00:00.000Z",
  );
  const newer = await createStoredSession(
    AuditStatus.COMPLETED,
    "2026-01-02T00:00:00.000Z",
  );
  await createStoredGroup(groupId, [older.sessionId, newer.sessionId]);

  const page = await listSessionGroupHierarchyPage({
    pageSize: 100,
    view: "groups",
  });
  const group = page.items.find(
    (item) => item.kind === "group" && item.groupId === groupId,
  );

  expect(group).toMatchObject({
    completedSessionCount: 2,
    kind: "group",
    sessionCount: 2,
  });
  expect(group).not.toHaveProperty("sessions");

  await expect(
    listSessionGroupMemberPage({ groupId, page: 1, pageSize: 1 }),
  ).resolves.toMatchObject({
    items: [{ sessionId: newer.sessionId }],
    page: 1,
    totalCount: 2,
    totalPages: 2,
  });
  await expect(
    listSessionGroupMemberPage({ groupId, page: 2, pageSize: 1 }),
  ).resolves.toMatchObject({
    items: [{ sessionId: older.sessionId }],
    page: 2,
  });

  await deleteSessionGroup({ groupId });
});

test("lists only Sessions with outstanding review findings", async () => {
  const groupId = `group-${randomUUID()}`;
  const empty = await createStoredSession(AuditStatus.COMPLETED);
  const lowOnly = await createStoredSession(AuditStatus.COMPLETED);
  const oneReview = await createStoredSession(AuditStatus.COMPLETED);
  const twoReviews = await createStoredSession(AuditStatus.COMPLETED);
  await createStoredGroup(groupId, [
    empty.sessionId,
    lowOnly.sessionId,
    oneReview.sessionId,
    twoReviews.sessionId,
  ]);
  await createStoredFinding(lowOnly.sessionId, Severity.LOW);
  await createStoredFinding(oneReview.sessionId, Severity.HIGH);
  await createStoredFinding(twoReviews.sessionId, Severity.HIGH);
  await createStoredFinding(twoReviews.sessionId, Severity.CRITICAL);
  await createStoredFinding(
    empty.sessionId,
    Severity.CRITICAL,
    HumanFindingStatus.TP,
  );

  const hierarchy = await listSessionGroupHierarchyPage({
    pageSize: 100,
    view: "groups",
  });
  expect(
    hierarchy.items.find(
      (item) => item.kind === "group" && item.groupId === groupId,
    ),
  ).toMatchObject({
    humanConfirmedFindingCount: 1,
    needsReviewFindingCount: 3,
    needsReviewSessionCount: 2,
    sessionCount: 4,
  });

  await expect(
    listSessionGroupMemberPage({
      groupId,
      page: 1,
      pageSize: 1,
      view: "needs-review",
    }),
  ).resolves.toMatchObject({
    items: [{ needsReviewFindingCount: 2, sessionId: twoReviews.sessionId }],
    page: 1,
    totalCount: 2,
    totalPages: 2,
  });
  await expect(
    listSessionGroupMemberPage({
      groupId,
      page: 2,
      pageSize: 1,
      view: "needs-review",
    }),
  ).resolves.toMatchObject({
    items: [{ needsReviewFindingCount: 1, sessionId: oneReview.sessionId }],
    page: 2,
  });

  await deleteSessionGroup({ groupId });
});

test("paginates only Sessions with human-confirmed findings", async () => {
  const groupId = `group-${randomUUID()}`;
  const older = await createStoredSession(
    AuditStatus.COMPLETED,
    "2026-01-01T00:00:00.000Z",
  );
  const newer = await createStoredSession(
    AuditStatus.COMPLETED,
    "2026-01-02T00:00:00.000Z",
  );
  const unconfirmed = await createStoredSession(
    AuditStatus.COMPLETED,
    "2026-01-03T00:00:00.000Z",
  );
  await createStoredGroup(groupId, [
    older.sessionId,
    newer.sessionId,
    unconfirmed.sessionId,
  ]);
  await createStoredFinding(
    older.sessionId,
    Severity.HIGH,
    HumanFindingStatus.TP,
  );
  await createStoredFinding(
    older.sessionId,
    Severity.CRITICAL,
    HumanFindingStatus.TP,
  );
  await createStoredFinding(
    newer.sessionId,
    Severity.MEDIUM,
    HumanFindingStatus.TP,
  );
  await createStoredFinding(unconfirmed.sessionId, Severity.CRITICAL);

  await expect(
    listSessionGroupMemberPage({
      groupId,
      page: 1,
      pageSize: 1,
      view: "human-confirmed",
    }),
  ).resolves.toMatchObject({
    items: [{ humanConfirmedFindingCount: 1, sessionId: newer.sessionId }],
    page: 1,
    totalCount: 2,
    totalPages: 2,
  });
  await expect(
    listSessionGroupMemberPage({
      groupId,
      page: 2,
      pageSize: 1,
      view: "human-confirmed",
    }),
  ).resolves.toMatchObject({
    items: [{ humanConfirmedFindingCount: 2, sessionId: older.sessionId }],
    page: 2,
  });

  await deleteSessionGroup({ groupId });
});

test("applies an independent Needs Review severity threshold to each Group", async () => {
  const highGroupId = `group-${randomUUID()}`;
  const mediumGroupId = `group-${randomUUID()}`;
  const highGroupSession = await createStoredSession(AuditStatus.COMPLETED);
  const mediumGroupSession = await createStoredSession(AuditStatus.COMPLETED);
  await createStoredGroup(highGroupId, [highGroupSession.sessionId]);
  await createStoredGroup(mediumGroupId, [mediumGroupSession.sessionId]);
  await createStoredFinding(highGroupSession.sessionId, Severity.MEDIUM);
  await createStoredFinding(mediumGroupSession.sessionId, Severity.MEDIUM);

  await expect(getSessionGroup(highGroupId)).resolves.toMatchObject({
    reviewMinSeverity: Severity.HIGH,
  });
  await expect(
    updateSessionGroupReviewMinSeverity({
      groupId: mediumGroupId,
      reviewMinSeverity: Severity.MEDIUM,
    }),
  ).resolves.toEqual({
    groupId: mediumGroupId,
    reviewMinSeverity: Severity.MEDIUM,
  });
  await expect(
    getSessionReviewMinSeverity(highGroupSession.sessionId),
  ).resolves.toBe(Severity.HIGH);
  await expect(
    getSessionReviewMinSeverity(mediumGroupSession.sessionId),
  ).resolves.toBe(Severity.MEDIUM);

  const hierarchy = await listSessionGroupHierarchyPage({
    pageSize: 100,
    view: "groups",
  });
  expect(
    hierarchy.items.find(
      (item) => item.kind === "group" && item.groupId === highGroupId,
    ),
  ).toMatchObject({
    needsReviewFindingCount: 0,
    needsReviewSessionCount: 0,
    reviewMinSeverity: Severity.HIGH,
  });
  expect(
    hierarchy.items.find(
      (item) => item.kind === "group" && item.groupId === mediumGroupId,
    ),
  ).toMatchObject({
    needsReviewFindingCount: 1,
    needsReviewSessionCount: 1,
    reviewMinSeverity: Severity.MEDIUM,
  });
  await expect(
    listSessionGroupMemberPage({
      groupId: highGroupId,
      view: "needs-review",
    }),
  ).resolves.toMatchObject({ items: [], totalCount: 0 });
  await expect(
    listSessionGroupMemberPage({
      groupId: mediumGroupId,
      view: "needs-review",
    }),
  ).resolves.toMatchObject({
    items: [
      { needsReviewFindingCount: 1, sessionId: mediumGroupSession.sessionId },
    ],
    totalCount: 1,
  });

  await deleteSessionGroup({ groupId: highGroupId });
  await deleteSessionGroup({ groupId: mediumGroupId });
});

test("deletes a Session Group, its Sessions, and their runtime directories", async () => {
  const groupId = `group-${randomUUID()}`;
  const first = await createStoredSession(AuditStatus.WAIT);
  const second = await createStoredSession(AuditStatus.COMPLETED);
  await createStoredGroup(groupId, [first.sessionId, second.sessionId]);
  await (
    await getDb()
  )
    .insert(sessionQueueItems)
    .values({
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      key: "session-group-delete-test",
      sessionId: first.sessionId,
      status: "queued",
    })
    .run();

  await expect(deleteSessionGroup({ groupId })).resolves.toEqual({
    deleted: true,
    deletedSessionIds: [first.sessionId, second.sessionId],
    groupId,
  });

  const db = await getDb();
  expect(
    await db
      .select()
      .from(sessionGroups)
      .where(eq(sessionGroups.id, groupId))
      .get(),
  ).toBeUndefined();
  for (const session of [first, second]) {
    expect(
      await db
        .select()
        .from(auditSessions)
        .where(eq(auditSessions.id, session.sessionId))
        .get(),
    ).toBeUndefined();
    await expect(access(session.sessionDir)).rejects.toThrow();
  }
  expect(
    await db
      .select()
      .from(sessionQueueItems)
      .where(eq(sessionQueueItems.sessionId, first.sessionId))
      .get(),
  ).toBeUndefined();
});

test("does not partially delete a Group that contains an active Session", async () => {
  const groupId = `group-${randomUUID()}`;
  const waiting = await createStoredSession(AuditStatus.WAIT);
  const running = await createStoredSession(AuditStatus.RUNNING);
  await createStoredGroup(groupId, [waiting.sessionId, running.sessionId]);

  await expect(deleteSessionGroup({ groupId })).rejects.toThrow(
    "contains running Sessions",
  );
  const db = await getDb();
  expect(
    await db
      .select()
      .from(sessionGroups)
      .where(eq(sessionGroups.id, groupId))
      .get(),
  ).toBeDefined();
  await expect(access(waiting.sessionDir)).resolves.toBeUndefined();
  await expect(access(running.sessionDir)).resolves.toBeUndefined();

  await db
    .update(auditSessions)
    .set({ status: AuditStatus.WAIT })
    .where(eq(auditSessions.id, running.sessionId))
    .run();
  await deleteSessionGroup({ groupId });
});

async function createStoredSession(
  status: string,
  createdAt = new Date().toISOString(),
) {
  const sessionId = `session-${randomUUID()}`;
  const sessionDir = path.join(process.cwd(), ".data", "session", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "artifact.txt"), "test");
  await (
    await getDb()
  )
    .insert(auditSessions)
    .values({
      createdAt,
      id: sessionId,
      programLogFile: path.join(sessionDir, "program.log"),
      projectName: sessionId,
      projectRoot: process.cwd(),
      sessionDir,
      status,
      targetPath: process.cwd(),
    })
    .run();
  return { sessionDir, sessionId };
}

async function createStoredGroup(groupId: string, sessionIds: string[]) {
  const db = await getDb();
  const createdAt = new Date().toISOString();
  await db
    .insert(sessionGroups)
    .values({ createdAt, id: groupId, name: groupId })
    .run();
  await db
    .insert(sessionGroupMembers)
    .values(
      sessionIds.map((sessionId, index) => ({
        createdAt,
        groupId,
        index,
        sessionId,
      })),
    )
    .run();
}

async function createStoredFinding(
  sessionId: string,
  severity: Severity,
  humanStatus?: HumanFindingStatus,
) {
  await (
    await getDb()
  )
    .insert(sessionFindings)
    .values({
      createdAt: new Date().toISOString(),
      description: "description",
      filePath: "src/example.sol",
      humanStatus,
      impact: "impact",
      rootCause: "root cause",
      sessionId,
      severity,
      status: SessionFindingStatus.CONFIRMED,
      title: `Finding ${randomUUID()}`,
    })
    .run();
}
