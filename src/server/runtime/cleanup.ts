import type { AuditSession } from "@/audit/session";
import { modelProviderQueueKey } from "@/audit/queue/model-provider-key";
import { AuditStatus } from "@/audit/session/types";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { auditSessions, sessionQueueItems } from "../db/schema";

type RuntimeCleanupState = {
  cleanupStarted: boolean;
  handlersInstalled: boolean;
  sessionTurnAbortControllers: Map<string, AbortController>;
  startupCleanupPromises: Map<string, Promise<void>>;
};

const globalForRuntimeCleanup = globalThis as unknown as {
  auditWorkbenchRuntimeCleanup?: RuntimeCleanupState;
};

const runtimeCleanup = (globalForRuntimeCleanup.auditWorkbenchRuntimeCleanup ??=
  {
    cleanupStarted: false,
    handlersInstalled: false,
    sessionTurnAbortControllers: new Map<string, AbortController>(),
    startupCleanupPromises: new Map<string, Promise<void>>(),
  });

runtimeCleanup.startupCleanupPromises ??= new Map<string, Promise<void>>();

const { sessionTurnAbortControllers, startupCleanupPromises } = runtimeCleanup;

export function ensureAppRuntimeCleanup(projectRoot = process.cwd()) {
  if (isNextBuildPhase()) {
    return Promise.resolve();
  }

  const resolvedProjectRoot = path.resolve(
    /*turbopackIgnore: true*/ projectRoot,
  );

  if (!runtimeCleanup.handlersInstalled) {
    installProcessCleanupHandlers();
    runtimeCleanup.handlersInstalled = true;
  }

  let cleanupPromise = startupCleanupPromises.get(resolvedProjectRoot);
  if (!cleanupPromise) {
    const startupPromise = recoverStaleRuntimeState(
      resolvedProjectRoot,
      "app_runtime_startup",
    ).then(() => {
      return import("@/audit/runner-consumer").then(() => undefined);
    });
    startupCleanupPromises.set(resolvedProjectRoot, startupPromise);
    void startupPromise.catch(() => {
      if (startupCleanupPromises.get(resolvedProjectRoot) === startupPromise) {
        startupCleanupPromises.delete(resolvedProjectRoot);
      }
    });
    cleanupPromise = startupPromise;
  }

  return cleanupPromise;
}

export async function trackAppSessionTurnAbortController(
  session: AuditSession,
) {
  const projectRoot = path.resolve(
    session.sessionDirectoryPath,
    "..",
    "..",
    "..",
  );
  const key = runtimeSessionKey(projectRoot, session.sessionId);
  const controller = new AbortController();
  sessionTurnAbortControllers.set(key, controller);

  const state = await (
    await getDb()
  )
    .select({ status: auditSessions.status })
    .from(auditSessions)
    .where(eq(auditSessions.id, session.sessionId))
    .get();
  if (state?.status === AuditStatus.INTERRUPTED) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    untrack: () => {
      if (sessionTurnAbortControllers.get(key) === controller) {
        sessionTurnAbortControllers.delete(key);
      }
    },
  };
}

export type StopAppSessionRuntimeResult = {
  abortedTurn: boolean;
  clearedQueueItems: number;
  interrupted: boolean;
  sessionId: string;
  status?: AuditStatus;
};

export async function stopAppSessionRuntime({
  projectRoot,
  reason = "session_stop_api",
  sessionId,
}: {
  projectRoot: string;
  reason?: string;
  sessionId: string;
}): Promise<StopAppSessionRuntimeResult> {
  const resolvedProjectRoot = path.resolve(
    /*turbopackIgnore: true*/ projectRoot,
  );
  const key = runtimeSessionKey(resolvedProjectRoot, sessionId);
  const controller = sessionTurnAbortControllers.get(key);
  let abortedTurn = false;
  if (controller && !controller.signal.aborted) {
    controller.abort();
    abortedTurn = true;
  }

  const clearedQueueItems = await clearSessionQueueItems(sessionId);
  const interrupted = await interruptSessionState(
    resolvedProjectRoot,
    sessionId,
    reason,
    {
      statuses: [AuditStatus.QUEUED, AuditStatus.RUNNING],
    },
  );
  const state = await (
    await getDb()
  )
    .select({ status: auditSessions.status })
    .from(auditSessions)
    .where(eq(auditSessions.id, sessionId))
    .get();

  return {
    abortedTurn,
    clearedQueueItems,
    interrupted,
    sessionId,
    status: state?.status as AuditStatus | undefined,
  };
}

export type RuntimeRecoveryResult = {
  queuedSessionIds: string[];
  restartedSessionIds: string[];
};

export async function recoverStaleRuntimeState(
  projectRoot: string,
  reason = "app_runtime_startup",
): Promise<RuntimeRecoveryResult> {
  const resolvedProjectRoot = path.resolve(
    /*turbopackIgnore: true*/ projectRoot,
  );
  const db = await getDb();
  const recovered = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(auditSessions)
      .where(
        inArray(auditSessions.status, [
          AuditStatus.QUEUED,
          AuditStatus.RUNNING,
        ]),
      )
      .orderBy(asc(auditSessions.createdAt))
      .all();
    const sessions: Array<{
      id: string;
      previousStatus: AuditStatus;
      sessionDir: string;
    }> = [];

    for (const row of rows) {
      const previousStatus = row.status as AuditStatus;
      const updated = await tx
        .update(auditSessions)
        .set({
          finishedAt: null,
          startedAt:
            previousStatus === AuditStatus.RUNNING ? null : row.startedAt,
          status: AuditStatus.QUEUED,
        })
        .where(
          and(
            eq(auditSessions.id, row.id),
            inArray(auditSessions.status, [
              AuditStatus.QUEUED,
              AuditStatus.RUNNING,
            ]),
          ),
        )
        .returning({ id: auditSessions.id })
        .get();
      if (!updated) {
        continue;
      }

      const queueKey = recoveredSessionQueueKey(row.agents);
      await tx
        .insert(sessionQueueItems)
        .values({
          id: randomUUID(),
          key: queueKey,
          sessionId: row.id,
          status: "queued",
          createdAt: row.createdAt,
        })
        .onConflictDoUpdate({
          target: sessionQueueItems.sessionId,
          set: {
            claimedAt: null,
            error: null,
            key: queueKey,
            status: "queued",
          },
        })
        .run();
      sessions.push({
        id: row.id,
        previousStatus,
        sessionDir: row.sessionDir,
      });
    }

    return sessions;
  });

  await Promise.all(
    recovered
      .filter((session) => session.previousStatus === AuditStatus.RUNNING)
      .map((session) =>
        appendSessionRecoveryLog(
          resolveProjectPath(resolvedProjectRoot, session.sessionDir),
          session.id,
          reason,
          session.previousStatus,
        ),
      ),
  );

  return {
    queuedSessionIds: recovered.map((session) => session.id),
    restartedSessionIds: recovered
      .filter((session) => session.previousStatus === AuditStatus.RUNNING)
      .map((session) => session.id),
  };
}

export async function interruptSessionState(
  projectRoot: string,
  sessionId: string,
  reason = "app_runtime_cleanup",
  options: {
    statuses?: readonly AuditStatus[];
  } = {},
) {
  const db = await getDb();
  const state = await db
    .select()
    .from(auditSessions)
    .where(eq(auditSessions.id, sessionId))
    .get();

  const activeStatuses = options.statuses ?? [AuditStatus.RUNNING];
  if (!state || !activeStatuses.includes(state.status as AuditStatus)) {
    return false;
  }

  await db
    .update(auditSessions)
    .set({
      finishedAt: new Date().toISOString(),
      status: AuditStatus.INTERRUPTED,
    })
    .where(eq(auditSessions.id, sessionId))
    .run();

  await appendSessionInterruptedLog(
    resolveProjectPath(projectRoot, state.sessionDir),
    sessionId,
    reason,
  );

  return true;
}

async function clearSessionQueueItems(sessionId: string) {
  const rows = await (
    await getDb()
  )
    .delete(sessionQueueItems)
    .where(eq(sessionQueueItems.sessionId, sessionId))
    .returning({ id: sessionQueueItems.id })
    .all();
  return rows.length;
}

function installProcessCleanupHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void cleanupAppRuntime().finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    });
  }

  process.once("uncaughtException", (error) => {
    void cleanupAppRuntime().finally(() => {
      process.nextTick(() => {
        throw error;
      });
    });
  });

  process.once("unhandledRejection", (reason) => {
    void cleanupAppRuntime().finally(() => {
      process.nextTick(() => {
        if (reason instanceof Error) {
          throw reason;
        }

        throw new Error(`Unhandled rejection: ${safeString(reason)}`);
      });
    });
  });
}

async function cleanupAppRuntime() {
  if (runtimeCleanup.cleanupStarted) {
    return;
  }

  runtimeCleanup.cleanupStarted = true;
}

export function isAppRuntimeShuttingDown() {
  return runtimeCleanup.cleanupStarted;
}

async function appendSessionInterruptedLog(
  sessionDir: string,
  sessionId: string,
  reason: string,
) {
  try {
    await appendFile(
      path.join(/*turbopackIgnore: true*/ sessionDir, "agent.log"),
      `${JSON.stringify({
        level: 40,
        time: new Date().toISOString(),
        session_id: sessionId,
        source: "program",
        reason,
        msg: "agent_session_interrupted",
      })}\n`,
      "utf8",
    );
  } catch {
    // The state file is the source of truth; logging is best-effort.
  }
}

async function appendSessionRecoveryLog(
  sessionDir: string,
  sessionId: string,
  reason: string,
  previousStatus: AuditStatus,
) {
  try {
    await appendFile(
      path.join(/*turbopackIgnore: true*/ sessionDir, "agent.log"),
      `${JSON.stringify({
        level: 30,
        time: new Date().toISOString(),
        session_id: sessionId,
        source: "program",
        reason,
        previous_status: previousStatus,
        msg: "agent_session_requeued_after_restart",
      })}\n`,
      "utf8",
    );
  } catch {
    // The database state is the source of truth; logging is best-effort.
  }
}

function safeString(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function recoveredSessionQueueKey(value: string) {
  try {
    const agentIds: unknown = JSON.parse(value);
    if (
      !Array.isArray(agentIds) ||
      agentIds.some((agentId) => typeof agentId !== "string")
    ) {
      throw new Error("Invalid stored Agent IDs.");
    }
    return modelProviderQueueKey(agentIds);
  } catch {
    return "unknown";
  }
}

function resolveProjectPath(projectRoot: string, filePath: string) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(/*turbopackIgnore: true*/ projectRoot, filePath);
}

function runtimeSessionKey(projectRoot: string, sessionId: string) {
  return `${path.resolve(/*turbopackIgnore: true*/ projectRoot)}:${sessionId}`;
}

function isNextBuildPhase() {
  return process.env.NEXT_PHASE === "phase-production-build";
}
