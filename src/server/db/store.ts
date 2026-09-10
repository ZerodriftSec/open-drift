import {
  DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
  HumanFindingStatus,
  isFindingAtOrAboveReviewSeverity,
  normalizeFindingMarkdownText,
  type Finding,
  type FindingReviewSeverity,
  type FindingId,
  type JsonObject,
  type AuditSessionSnapshot,
  type StoredFinding,
} from "@/audit/session/types";
import {
  deserializeWorkflowStateSnapshot,
  type WorkflowStateSnapshot,
} from "@/audit/workflow/status";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb, type DbExecutor } from ".";
import {
  SessionFindingStatus,
  auditSessions,
  sessionFindingReviews,
  sessionFindings,
  sessionQueueItems,
  uploads,
  type AuditSessionRow,
  type SessionFindingStatus as SessionFindingStatusValue,
  type SessionFindingInsert,
  type SessionFindingReviewRow,
  type SessionFindingRow,
  type UploadRow,
} from "./schema";
import { createQueueStore, Queue } from "@/audit/queue";
import { taskSourceOrDefault } from "@/lib/task-metadata";
import { AuditStatus } from "@/audit/session/types";
import { WorkflowDefinition } from "@/audit/workflow";
import type { HumanFindingReview } from "../sessions";
import type { UploadState } from "../uploads";

const globalForSessionQueue = globalThis as unknown as {
  sessionQueue?: Queue;
};

export function getSessionQueue() {
  globalForSessionQueue.sessionQueue ??= new Queue(createQueueStore(), {
    acknowledgeOnStart: true,
  });
  return globalForSessionQueue.sessionQueue;
}

export async function countSessionStatesInDb() {
  return (await getDb()).$count(auditSessions);
}

export async function listSessionStatesFromDb({
  skip,
  take,
}: {
  skip?: number;
  take?: number;
} = {}) {
  const rows = await (
    await getDb()
  )
    .select()
    .from(auditSessions)
    .orderBy(desc(auditSessions.createdAt))
    .limit(take ?? -1)
    .offset(skip ?? 0);
  return Promise.all(rows.map((row) => dbSessionToState(row)));
}

export async function listSessionStatesByIdsFromDb(
  sessionIds: readonly string[],
) {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) {
    return [];
  }

  const rows = await (
    await getDb()
  )
    .select()
    .from(auditSessions)
    .where(inArray(auditSessions.id, ids));
  return Promise.all(rows.map((row) => dbSessionToState(row)));
}

export async function readSessionStateFromDb(sessionId: string) {
  const row = await (
    await getDb()
  )
    .select()
    .from(auditSessions)
    .where(eq(auditSessions.id, sessionId))
    .get();
  return row ? await dbSessionToState(row) : null;
}

export async function upsertSessionStateToDb(state: AuditSessionSnapshot) {
  const data = sessionStateToDbData(state);
  await (
    await getDb()
  )
    .insert(auditSessions)
    .values({
      id: state.sessionId,
      ...data,
    })
    .onConflictDoUpdate({
      target: auditSessions.id,
      set: data,
    })
    .run();
}

export async function updateSessionStatusInDb({
  sessionId,
  status,
}: {
  sessionId: string;
  status: AuditStatus;
}) {
  const now = new Date().toISOString();
  const rows = await (
    await getDb()
  )
    .update(auditSessions)
    .set({
      status,
      ...(status === AuditStatus.RUNNING
        ? { startedAt: sql`coalesce(${auditSessions.startedAt}, ${now})` }
        : {}),
      ...(isTerminalAuditStatus(status)
        ? { finishedAt: sql`coalesce(${auditSessions.finishedAt}, ${now})` }
        : {}),
    })
    .where(eq(auditSessions.id, sessionId))
    .returning({ id: auditSessions.id })
    .all();

  return rows.length === 1;
}

export async function claimQueuedSessionExecutionInDb(sessionId: string) {
  const now = new Date().toISOString();
  const rows = await (
    await getDb()
  )
    .update(auditSessions)
    .set({
      finishedAt: null,
      startedAt: sql`coalesce(${auditSessions.startedAt}, ${now})`,
      status: AuditStatus.RUNNING,
    })
    .where(
      and(
        eq(auditSessions.id, sessionId),
        eq(auditSessions.status, AuditStatus.QUEUED),
      ),
    )
    .returning({ id: auditSessions.id })
    .all();

  return rows.length === 1;
}

export async function claimSessionExecutionInDb(sessionId: string) {
  const now = new Date().toISOString();
  const rows = await (
    await getDb()
  )
    .update(auditSessions)
    .set({
      finishedAt: null,
      startedAt: sql`coalesce(${auditSessions.startedAt}, ${now})`,
      status: AuditStatus.RUNNING,
    })
    .where(
      and(
        eq(auditSessions.id, sessionId),
        notInArray(auditSessions.status, [
          AuditStatus.QUEUED,
          AuditStatus.RUNNING,
        ]),
      ),
    )
    .returning({ id: auditSessions.id })
    .all();

  return rows.length === 1;
}

export type DequeueSessionResult = {
  outcome:
    | "already-waiting"
    | "dequeued"
    | "not-found"
    | "not-queued"
    | "queue-item-claimed";
  removedQueueItems: number;
  status?: AuditStatus;
};

export async function dequeueSessionInDb(
  sessionId: string,
): Promise<DequeueSessionResult> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const state = await tx
      .select({ status: auditSessions.status })
      .from(auditSessions)
      .where(eq(auditSessions.id, sessionId))
      .get();
    if (!state) {
      return {
        outcome: "not-found",
        removedQueueItems: 0,
      };
    }

    const status = state.status as AuditStatus;
    if (status === AuditStatus.WAIT) {
      return {
        outcome: "already-waiting",
        removedQueueItems: 0,
        status,
      };
    }
    if (status !== AuditStatus.QUEUED) {
      return {
        outcome: "not-queued",
        removedQueueItems: 0,
        status,
      };
    }

    const queueItem = await tx
      .select({ status: sessionQueueItems.status })
      .from(sessionQueueItems)
      .where(eq(sessionQueueItems.sessionId, sessionId))
      .get();
    if (queueItem && queueItem.status !== "queued") {
      return {
        outcome: "queue-item-claimed",
        removedQueueItems: 0,
        status,
      };
    }

    const removedQueueItems = await tx
      .delete(sessionQueueItems)
      .where(
        and(
          eq(sessionQueueItems.sessionId, sessionId),
          eq(sessionQueueItems.status, "queued"),
        ),
      )
      .returning({ id: sessionQueueItems.id })
      .all();
    const updated = await tx
      .update(auditSessions)
      .set({
        finishedAt: null,
        status: AuditStatus.WAIT,
      })
      .where(
        and(
          eq(auditSessions.id, sessionId),
          eq(auditSessions.status, AuditStatus.QUEUED),
        ),
      )
      .returning({ id: auditSessions.id })
      .get();
    if (!updated) {
      throw new Error(`Session status changed while dequeuing: ${sessionId}`);
    }

    return {
      outcome: "dequeued",
      removedQueueItems: removedQueueItems.length,
      status: AuditStatus.WAIT,
    };
  });
}

export async function updateSessionWorkflowStateInDb({
  workflowState,
  sessionId,
}: {
  workflowState: WorkflowStateSnapshot;
  sessionId: string;
}) {
  await (
    await getDb()
  )
    .update(auditSessions)
    .set({ workflowState: JSON.stringify(workflowState) })
    .where(eq(auditSessions.id, sessionId))
    .run();
}

export async function updateSessionWorkflowSnapshotInDb({
  sessionId,
  workflow,
}: {
  sessionId: string;
  workflow: WorkflowDefinition;
}) {
  const rows = await (
    await getDb()
  )
    .update(auditSessions)
    .set({ workflow: workflow.serialize() })
    .where(
      and(
        eq(auditSessions.id, sessionId),
        ne(auditSessions.status, AuditStatus.RUNNING),
      ),
    )
    .returning({ id: auditSessions.id })
    .all();

  return rows.length === 1;
}

export async function deleteSessionStateFromDb(sessionId: string) {
  await (
    await getDb()
  )
    .delete(auditSessions)
    .where(eq(auditSessions.id, sessionId))
    .run();
}

export async function appendSessionFindingToDb({
  finding,
  status,
  sessionId,
}: {
  finding: Finding;
  status: SessionFindingStatusValue;
  sessionId: string;
}) {
  const db = await getDb();
  const storedFinding = storedSessionFinding({
    finding,
    sessionId,
  });

  const row = await db
    .insert(sessionFindings)
    .values(
      sessionFindingToDbRow({ finding: storedFinding, status, sessionId }),
    )
    .returning()
    .get();

  return { finding: dbSessionFindingToFinding(row) };
}

export async function listSessionFindingsFromDb({
  status,
  sessionId,
}: {
  status?: SessionFindingStatusValue;
  sessionId: string;
}) {
  const rows = await (
    await getDb()
  )
    .select()
    .from(sessionFindings)
    .where(
      status
        ? and(
            eq(sessionFindings.sessionId, sessionId),
            eq(sessionFindings.status, status),
          )
        : eq(sessionFindings.sessionId, sessionId),
    )
    .orderBy(asc(sessionFindings.createdAt), asc(sessionFindings.id))
    .all();
  return rows.map(dbSessionFindingToFinding);
}

export async function listCanonicalSessionFindingsFromDb({
  sessionId,
}: {
  sessionId: string;
}) {
  const rows = await (
    await getDb()
  )
    .select()
    .from(sessionFindings)
    .where(
      and(
        eq(sessionFindings.sessionId, sessionId),
        inArray(sessionFindings.status, [
          SessionFindingStatus.CONFIRMED,
          SessionFindingStatus.ONCHAIN_CONFIRMED,
        ]),
      ),
    )
    .orderBy(asc(sessionFindings.createdAt), asc(sessionFindings.id))
    .all();
  return rows.map(dbSessionFindingToFinding);
}

export async function listSessionFindingSeverityCountsFromDb(
  sessionIds: string[],
) {
  if (sessionIds.length === 0) return [];

  return await (
    await getDb()
  )
    .select({
      count: sql<number>`count(*)`,
      sessionId: sessionFindings.sessionId,
      severity: sessionFindings.severity,
    })
    .from(sessionFindings)
    .where(
      and(
        inArray(sessionFindings.sessionId, sessionIds),
        inArray(sessionFindings.status, [
          SessionFindingStatus.CONFIRMED,
          SessionFindingStatus.ONCHAIN_CONFIRMED,
        ]),
      ),
    )
    .groupBy(sessionFindings.sessionId, sessionFindings.severity)
    .all();
}

export async function listSessionHumanConfirmedFindingCountsFromDb(
  sessionIds: string[],
) {
  if (sessionIds.length === 0) return [];

  return await (
    await getDb()
  )
    .select({
      count: sql<number>`count(*)`,
      sessionId: sessionFindings.sessionId,
    })
    .from(sessionFindings)
    .where(
      and(
        inArray(sessionFindings.sessionId, sessionIds),
        inArray(sessionFindings.status, [
          SessionFindingStatus.PENDING,
          SessionFindingStatus.CONFIRMED,
          SessionFindingStatus.ONCHAIN_CONFIRMED,
        ]),
        eq(sessionFindings.humanStatus, HumanFindingStatus.TP),
      ),
    )
    .groupBy(sessionFindings.sessionId)
    .all();
}

export async function listSessionHumanConfirmedFindingsFromDb(
  sessionIds: string[],
) {
  if (sessionIds.length === 0) return [];

  const rows = await (
    await getDb()
  )
    .select()
    .from(sessionFindings)
    .where(
      and(
        inArray(sessionFindings.sessionId, sessionIds),
        inArray(sessionFindings.status, [
          SessionFindingStatus.PENDING,
          SessionFindingStatus.CONFIRMED,
          SessionFindingStatus.ONCHAIN_CONFIRMED,
        ]),
        eq(sessionFindings.humanStatus, HumanFindingStatus.TP),
      ),
    )
    .orderBy(asc(sessionFindings.createdAt), asc(sessionFindings.id))
    .all();

  return rows.map(dbSessionFindingToFinding);
}

export async function listSessionNeedsReviewFindingCountsFromDb(
  sessionIds: string[],
  reviewMinSeverity: FindingReviewSeverity = DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
) {
  if (sessionIds.length === 0) return [];

  const rows = await (
    await getDb()
  )
    .select({
      sessionId: sessionFindings.sessionId,
      severity: sessionFindings.severity,
    })
    .from(sessionFindings)
    .where(
      and(
        inArray(sessionFindings.sessionId, sessionIds),
        eq(sessionFindings.status, SessionFindingStatus.CONFIRMED),
        isNull(sessionFindings.humanStatus),
      ),
    )
    .all();
  const countsBySession = new Map<string, number>();

  for (const row of rows) {
    if (
      !isFindingAtOrAboveReviewSeverity(
        row.severity as FindingReviewSeverity,
        reviewMinSeverity,
      )
    ) {
      continue;
    }
    countsBySession.set(
      row.sessionId,
      (countsBySession.get(row.sessionId) ?? 0) + 1,
    );
  }

  return [...countsBySession].map(([sessionId, count]) => ({
    count,
    sessionId,
  }));
}

export async function updateSessionFindingNoteInDb({
  findingId,
  note,
  sessionId,
}: {
  findingId: FindingId | string;
  note: string | null;
  sessionId: string;
}) {
  const numericFindingId = normalizeFindingDbId(findingId);
  if (numericFindingId === null) {
    return null;
  }

  const db = await getDb();
  const result = await db
    .update(sessionFindings)
    .set({ note })
    .where(
      and(
        eq(sessionFindings.sessionId, sessionId),
        eq(sessionFindings.id, numericFindingId),
      ),
    )
    .run();
  if (result.rowsAffected === 0) {
    return null;
  }

  const row = await db
    .select()
    .from(sessionFindings)
    .where(
      and(
        eq(sessionFindings.sessionId, sessionId),
        eq(sessionFindings.id, numericFindingId),
      ),
    )
    .get();

  return row ? dbSessionFindingToFinding(row) : null;
}

export async function updateSessionFindingHumanStatusInDb({
  findingId,
  humanStatus,
  sessionId,
}: {
  findingId: FindingId | string;
  humanStatus: HumanFindingStatus | null;
  sessionId: string;
}) {
  const numericFindingId = normalizeFindingDbId(findingId);
  if (numericFindingId === null) {
    return null;
  }

  const db = await getDb();
  const result = await db
    .update(sessionFindings)
    .set({ humanStatus })
    .where(
      and(
        eq(sessionFindings.sessionId, sessionId),
        eq(sessionFindings.id, numericFindingId),
      ),
    )
    .run();
  if (result.rowsAffected === 0) {
    return null;
  }

  const row = await db
    .select()
    .from(sessionFindings)
    .where(
      and(
        eq(sessionFindings.sessionId, sessionId),
        eq(sessionFindings.id, numericFindingId),
      ),
    )
    .get();

  return row ? dbSessionFindingToFinding(row) : null;
}

export async function updateSessionFindingInDb({
  finding,
  sessionId,
}: {
  finding: Finding;
  sessionId: string;
}) {
  const findingId = normalizeFindingDbId(finding.id);
  if (findingId === null) {
    return null;
  }

  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const mutableFinding = await tx
      .select({ id: sessionFindings.id })
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, findingId),
          eq(sessionFindings.status, SessionFindingStatus.PENDING),
        ),
      )
      .get();
    if (!mutableFinding) {
      return undefined;
    }

    await tx
      .update(sessionFindings)
      .set({
        description: finding.description,
        duplicateOfId: null,
        filePath: finding.file_path,
        impact: finding.impact,
        note: finding.note ?? null,
        recommendation: finding.recommendation ?? null,
        rootCause: finding.root_cause,
        severity: finding.severity,
        sourceLocations: serializeSourceLocations(finding.source_locations),
        title: finding.title,
      })
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, findingId),
          eq(sessionFindings.status, SessionFindingStatus.PENDING),
        ),
      )
      .run();

    return await tx
      .select()
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, findingId),
        ),
      )
      .get();
  });

  return row ? dbSessionFindingToFinding(row) : null;
}

export async function confirmSessionFindingInDb({
  findingId,
  reason,
  sessionId,
}: {
  findingId: FindingId | string;
  reason: string;
  sessionId: string;
}) {
  const numericFindingId = normalizeFindingDbId(findingId);
  if (numericFindingId === null) {
    return null;
  }

  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const confirmableFinding = await tx
      .select()
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
          inArray(sessionFindings.status, [
            SessionFindingStatus.PENDING,
            SessionFindingStatus.CONFIRMED,
          ]),
        ),
      )
      .get();
    if (!confirmableFinding) {
      return undefined;
    }

    await tx
      .update(sessionFindings)
      .set({
        confirmationReason: reason,
        duplicateOfId: null,
        rejectionReason: null,
        status: SessionFindingStatus.CONFIRMED,
      })
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
          inArray(sessionFindings.status, [
            SessionFindingStatus.PENDING,
            SessionFindingStatus.CONFIRMED,
          ]),
        ),
      )
      .run();

    return await tx
      .select()
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
        ),
      )
      .get();
  });

  return row ? dbSessionFindingToFinding(row) : null;
}

export async function rejectSessionFindingInDb({
  findingId,
  reason,
  sessionId,
}: {
  findingId: FindingId | string;
  reason: string;
  sessionId: string;
}) {
  const numericFindingId = normalizeFindingDbId(findingId);
  if (numericFindingId === null) {
    return null;
  }

  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const pendingFinding = await tx
      .select({ id: sessionFindings.id })
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
          eq(sessionFindings.status, SessionFindingStatus.PENDING),
        ),
      )
      .get();
    if (!pendingFinding) {
      return undefined;
    }

    await tx
      .update(sessionFindings)
      .set({
        duplicateOfId: null,
        rejectionReason: reason,
        status: SessionFindingStatus.REJECTED,
      })
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
          eq(sessionFindings.status, SessionFindingStatus.PENDING),
        ),
      )
      .run();

    return await tx
      .select()
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
        ),
      )
      .get();
  });

  return row ? dbSessionFindingToFinding(row) : null;
}

export async function onchainConfirmSessionFindingInDb({
  economicImpact,
  findingId,
  sessionId,
  triggeredActor,
  triggerConditions,
}: {
  economicImpact: string;
  findingId: FindingId | string;
  sessionId: string;
  triggeredActor: string;
  triggerConditions: string;
}) {
  const numericFindingId = normalizeFindingDbId(findingId);
  if (numericFindingId === null) {
    return null;
  }

  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const pendingFinding = await tx
      .select({ id: sessionFindings.id })
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
          eq(sessionFindings.status, SessionFindingStatus.PENDING),
        ),
      )
      .get();
    if (!pendingFinding) {
      return undefined;
    }

    await tx
      .update(sessionFindings)
      .set({
        duplicateOfId: null,
        economicImpact,
        status: SessionFindingStatus.ONCHAIN_CONFIRMED,
        triggeredActor,
        triggerConditions,
      })
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
          eq(sessionFindings.status, SessionFindingStatus.PENDING),
        ),
      )
      .run();

    return await tx
      .select()
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
        ),
      )
      .get();
  });

  return row ? dbSessionFindingToFinding(row) : null;
}

export async function markSessionFindingDuplicateInDb({
  duplicateOfId,
  findingId,
  sessionId,
}: {
  duplicateOfId: FindingId | string;
  findingId: FindingId | string;
  sessionId: string;
}) {
  const numericFindingId = normalizeFindingDbId(findingId);
  const numericDuplicateOfId = normalizeFindingDbId(duplicateOfId);
  if (numericFindingId === null || numericDuplicateOfId === null) {
    return null;
  }

  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    if (numericFindingId === numericDuplicateOfId) {
      return null;
    }

    const duplicateOfRow = await tx
      .select({ id: sessionFindings.id })
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericDuplicateOfId),
        ),
      )
      .get();

    if (!duplicateOfRow) {
      return null;
    }

    await tx
      .update(sessionFindings)
      .set({
        duplicateOfId: numericDuplicateOfId,
        status: SessionFindingStatus.DUPLICATE,
      })
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
        ),
      )
      .run();

    return await tx
      .select()
      .from(sessionFindings)
      .where(
        and(
          eq(sessionFindings.sessionId, sessionId),
          eq(sessionFindings.id, numericFindingId),
        ),
      )
      .get();
  });

  return row ? dbSessionFindingToFinding(row) : null;
}

export async function appendSessionFindingReviewToDb({
  review,
  sessionId,
}: {
  review: HumanFindingReview;
  sessionId: string;
}) {
  await (
    await getDb()
  )
    .insert(sessionFindingReviews)
    .values({
      action: review.action,
      findingKey: review.findingKey,
      id: stableDbId(
        "session-finding-review",
        sessionId,
        review.findingKey,
        review.action,
        review.reviewedAt,
      ),
      reviewedAt: dateValue(review.reviewedAt),
      sessionId,
    })
    .run();
}

export async function listSessionFindingReviewsFromDb(sessionId: string) {
  const rows = await (
    await getDb()
  )
    .select()
    .from(sessionFindingReviews)
    .where(eq(sessionFindingReviews.sessionId, sessionId))
    .orderBy(asc(sessionFindingReviews.reviewedAt))
    .all();
  return rows.map(dbSessionFindingReviewToReview);
}

export async function clearSessionFindingArtifactsFromDb(sessionId: string) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx
      .delete(sessionFindings)
      .where(eq(sessionFindings.sessionId, sessionId))
      .run();
    await tx
      .delete(sessionFindingReviews)
      .where(eq(sessionFindingReviews.sessionId, sessionId))
      .run();
  });
}

export async function readUploadStateFromDb(uploadId: string) {
  const row = await (
    await getDb()
  )
    .select()
    .from(uploads)
    .where(eq(uploads.id, uploadId))
    .get();
  return row ? dbUploadToState(row) : null;
}

export async function upsertUploadStateToDb(upload: UploadState) {
  const data = {
    workflowId: upload.workflowId,
    metadata: upload.metadata ? JSON.stringify(upload.metadata) : null,
    projectName: upload.projectName ?? null,
    source: taskSourceOrDefault(upload.source),
    targetPath: upload.targetPath,
  };
  await (
    await getDb()
  )
    .insert(uploads)
    .values({
      id: upload.uploadId,
      ...data,
    })
    .onConflictDoUpdate({
      target: uploads.id,
      set: data,
    })
    .run();
}

async function dbSessionToState(
  row: AuditSessionRow,
): Promise<AuditSessionSnapshot> {
  const counts = await sessionFindingCounts(await getDb(), row.id);
  const workflow = WorkflowDefinition.deserialize(row.workflow);
  return {
    agents: jsonStringArrayValue(row.agents) ?? [],
    workflowState: deserializeWorkflowStateSnapshot(
      row.workflowState,
      workflow,
    ),
    stageAgentAssignments: jsonStringRecordValue(row.stageAgentAssignments),
    workflow,
    workflowId: row.workflowId,
    createdAt: dateIso(row.createdAt),
    findingCount: counts.findingCount,
    programLogFile: row.programLogFile,
    agentLogFile: row.agentLogFile ?? undefined,
    metadata: jsonObjectValue(row.metadata),
    pendingFindingCount: counts.pendingFindingCount,
    aiConfirmedFindingCount: counts.aiConfirmedFindingCount,
    projectName: row.projectName || row.id,
    projectRoot: row.projectRoot,
    sessionDir: row.sessionDir,
    sessionId: row.id,
    source: taskSourceOrDefault(row.source),
    status: row.status as AuditStatus,
    targetPath: row.targetPath,
    startedAt: optionalDateIso(row.startedAt),
    finishedAt: optionalDateIso(row.finishedAt),
    workingDirectory: row.workingDirectory ?? undefined,
  };
}

function sessionStateToDbData(state: AuditSessionSnapshot) {
  return {
    agents: JSON.stringify(state.agents),
    workflowState: JSON.stringify(state.workflowState),
    stageAgentAssignments: JSON.stringify(state.stageAgentAssignments ?? {}),
    workflow: state.workflow.serialize(),
    workflowId: state.workflowId,
    createdAt: dateValue(state.createdAt),
    programLogFile: state.programLogFile,
    agentLogFile: state.agentLogFile ?? null,
    metadata: state.metadata ? JSON.stringify(state.metadata) : null,
    projectName: state.projectName || state.sessionId,
    projectRoot: state.projectRoot,
    sessionDir: state.sessionDir,
    startedAt: optionalDateValue(state.startedAt),
    source: taskSourceOrDefault(state.source),
    status: state.status,
    targetPath: state.targetPath,
    finishedAt: optionalDateValue(state.finishedAt),
    workingDirectory: state.workingDirectory ?? null,
  };
}

function isTerminalAuditStatus(status: AuditStatus) {
  return (
    status === AuditStatus.COMPLETED ||
    status === AuditStatus.FAILED ||
    status === AuditStatus.INTERRUPTED
  );
}

type PersistableSessionFinding = Finding & {
  session_id: string;
};

function sessionFindingToDbRow({
  createdAt = new Date().toISOString(),
  finding,
  status,
  sessionId,
}: {
  createdAt?: string;
  finding: PersistableSessionFinding;
  status: SessionFindingStatusValue;
  sessionId: string;
}): SessionFindingInsert {
  const row: SessionFindingInsert = {
    createdAt,
    description: finding.description,
    duplicateOfId: normalizeFindingDbId(finding.duplicate_of_id) ?? null,
    filePath: finding.file_path,
    rootCause: finding.root_cause,
    sessionId,
    severity: finding.severity,
    status,
    impact: finding.impact ?? null,
    economicImpact: finding.economic_impact ?? null,
    confirmationReason: finding.confirmation_reason ?? null,
    humanStatus: finding.human_status ?? null,
    rejectionReason: finding.rejection_reason ?? null,
    recommendation: finding.recommendation ?? null,
    note: finding.note ?? null,
    sourceLocations: serializeSourceLocations(finding.source_locations),
    title: finding.title,
    triggeredActor: finding.triggered_actor ?? null,
    triggerConditions: finding.trigger_conditions ?? null,
  };
  const findingId = normalizeFindingDbId(finding.id);
  if (findingId !== null) {
    row.id = findingId;
  }

  return row;
}

function dbSessionFindingToFinding(row: SessionFindingRow): StoredFinding {
  const finding: StoredFinding = {
    description: normalizeFindingMarkdownText(row.description),
    file_path: row.filePath,
    id: row.id,
    impact: normalizeFindingMarkdownText(row.impact ?? ""),
    root_cause: normalizeFindingMarkdownText(row.rootCause),
    session_id: row.sessionId,
    severity: row.severity as Finding["severity"],
    status: row.status as SessionFindingStatusValue,
    title: row.title,
  };

  if (row.duplicateOfId) {
    finding.duplicate_of_id = row.duplicateOfId;
  }

  if (row.recommendation) {
    finding.recommendation = normalizeFindingMarkdownText(row.recommendation);
  }

  if (row.triggerConditions) {
    finding.trigger_conditions = normalizeFindingMarkdownText(
      row.triggerConditions,
    );
  }

  if (row.triggeredActor) {
    finding.triggered_actor = normalizeFindingMarkdownText(row.triggeredActor);
  }

  if (row.economicImpact) {
    finding.economic_impact = normalizeFindingMarkdownText(row.economicImpact);
  }

  if (row.confirmationReason) {
    finding.confirmation_reason = normalizeFindingMarkdownText(
      row.confirmationReason,
    );
  }

  if (row.rejectionReason) {
    finding.rejection_reason = normalizeFindingMarkdownText(
      row.rejectionReason,
    );
  }

  if (row.note) {
    finding.note = normalizeFindingMarkdownText(row.note);
  }

  const humanStatus = humanFindingStatusValue(row.humanStatus);
  if (humanStatus) {
    finding.human_status = humanStatus;
  }

  const sourceLocations = parseSourceLocations(row.sourceLocations);
  if (sourceLocations) {
    finding.source_locations = sourceLocations;
  }

  return finding;
}

function serializeSourceLocations(
  value: Finding["source_locations"] | undefined,
): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseSourceLocations(
  value: string | null,
): Finding["source_locations"] | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed as Finding["source_locations"])
      : undefined;
  } catch {
    return undefined;
  }
}

function humanFindingStatusValue(
  value: string | null,
): HumanFindingStatus | null {
  return value === "tp" || value === "fp" ? value : null;
}

function storedSessionFinding({
  finding,
  sessionId,
}: {
  finding: Finding;
  sessionId: string;
}): PersistableSessionFinding {
  return {
    ...finding,
    session_id: finding.session_id ?? sessionId,
  };
}

function normalizeFindingDbId(
  value: FindingId | string | null | undefined,
): FindingId | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const numericValue = Number(trimmed);
  return Number.isSafeInteger(numericValue) && numericValue > 0
    ? numericValue
    : null;
}

function dbSessionFindingReviewToReview(
  row: SessionFindingReviewRow,
): HumanFindingReview {
  return {
    action: row.action as HumanFindingReview["action"],
    findingKey: row.findingKey,
    reviewedAt: dateIso(row.reviewedAt),
  };
}

async function sessionFindingCounts(db: DbExecutor, sessionId: string) {
  const rows = await db
    .select({
      duplicateOfId: sessionFindings.duplicateOfId,
      id: sessionFindings.id,
      severity: sessionFindings.severity,
      status: sessionFindings.status,
    })
    .from(sessionFindings)
    .where(eq(sessionFindings.sessionId, sessionId))
    .all();
  const confirmedCount = rows.filter(
    (row) =>
      row.status === SessionFindingStatus.CONFIRMED ||
      row.status === SessionFindingStatus.ONCHAIN_CONFIRMED,
  ).length;
  return {
    aiConfirmedFindingCount: rows.filter(
      (row) =>
        row.status === SessionFindingStatus.CONFIRMED &&
        isFindingAtOrAboveReviewSeverity(row.severity as FindingReviewSeverity),
    ).length,
    findingCount: confirmedCount,
    pendingFindingCount: rows.filter(
      (row) => row.status === SessionFindingStatus.PENDING,
    ).length,
  };
}

function jsonObjectValue(value: string | null): JsonObject | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function jsonStringArrayValue(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function jsonStringRecordValue(
  value: string | null,
): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return undefined;
  }
}

function dbUploadToState(row: UploadRow): UploadState {
  return {
    workflowId: row.workflowId,
    metadata: jsonObjectValue(row.metadata),
    projectName: row.projectName ?? undefined,
    source: taskSourceOrDefault(row.source),
    targetPath: row.targetPath,
    uploadId: row.id,
  };
}

function dateValue(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function optionalDateValue(value?: string | Date | null) {
  return value ? dateValue(value) : null;
}

function dateIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function optionalDateIso(value?: Date | string | null) {
  return value ? dateIso(value) : undefined;
}

function stableDbId(...parts: string[]) {
  return createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32);
}
