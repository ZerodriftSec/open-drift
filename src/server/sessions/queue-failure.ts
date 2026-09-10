import { appendFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { AuditStatus } from "@/audit/session/types";
import { getDb } from "@/server/db";
import { auditSessions } from "@/server/db/schema";

export async function recordSessionQueueConsumerFailure(
  sessionId: string,
  error: unknown,
) {
  const now = new Date().toISOString();
  const row = await (
    await getDb()
  )
    .update(auditSessions)
    .set({
      finishedAt: now,
      status: AuditStatus.FAILED,
    })
    .where(
      and(
        eq(auditSessions.id, sessionId),
        inArray(auditSessions.status, [
          AuditStatus.QUEUED,
          AuditStatus.RUNNING,
        ]),
      ),
    )
    .returning({
      agentLogFile: auditSessions.agentLogFile,
      sessionDir: auditSessions.sessionDir,
    })
    .get();

  if (!row) return;

  const serializedError = serializeError(error);
  const logFile = row.agentLogFile ?? path.join(row.sessionDir, "agent.log");
  await appendFile(
    logFile,
    `${JSON.stringify({
      level: 50,
      time: Date.now(),
      err: serializedError,
      msg: "queue_consumer_failed",
    })}\n`,
    "utf8",
  );
}

function serializeError(error: unknown) {
  return error instanceof Error
    ? {
        message: error.message,
        name: error.name,
        stack: error.stack,
      }
    : { message: String(error) };
}
