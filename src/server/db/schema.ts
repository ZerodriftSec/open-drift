import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const SessionFindingStatus = {
  CONFIRMED: "confirmed",
  DUPLICATE: "duplicate",
  ONCHAIN_CONFIRMED: "onchain_confirm",
  PENDING: "pending",
  REJECTED: "rejected",
} as const;

export type SessionFindingStatus =
  (typeof SessionFindingStatus)[keyof typeof SessionFindingStatus];

export const auditSessions = sqliteTable(
  "AuditSession",
  {
    id: text("id").primaryKey().notNull(),
    agents: text("agents").notNull().default("[]"),
    workflow: text("workflow").notNull().default('{"stages":[]}'),
    workflowState: text("workflowState")
      .notNull()
      .default('{"mode":"idle","status":"idle","stages":[],"updatedAt":""}'),
    workflowId: text("workflowId").notNull().default("main-audit"),
    stageAgentAssignments: text("stageAgentAssignments")
      .notNull()
      .default("{}"),
    projectName: text("projectName").notNull(),
    source: text("source"),
    metadata: text("metadata"),
    status: text("status").notNull(),
    projectRoot: text("projectRoot").notNull(),
    targetPath: text("targetPath").notNull(),
    workingDirectory: text("workingDirectory"),
    sessionDir: text("sessionDir").notNull(),
    programLogFile: text("programLogFile").notNull(),
    agentLogFile: text("agentLogFile"),
    createdAt: text("createdAt").notNull(),
    startedAt: text("startedAt"),
    finishedAt: text("finishedAt"),
  },
  (table) => [
    index("AuditSession_agents_idx").on(table.agents),
    index("AuditSession_workflowId_idx").on(table.workflowId),
    index("AuditSession_createdAt_idx").on(table.createdAt),
    index("AuditSession_projectName_idx").on(table.projectName),
    index("AuditSession_source_idx").on(table.source),
    index("AuditSession_status_idx").on(table.status),
  ],
);

export const sessionFindings = sqliteTable(
  "SessionFinding",
  {
    id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
    duplicateOfId: integer("duplicateOfId"),
    sessionId: text("sessionId")
      .notNull()
      .references(() => auditSessions.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    status: text("status").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    rootCause: text("rootCause").notNull(),
    severity: text("severity").notNull(),
    filePath: text("filePath").notNull(),
    impact: text("impact"),
    triggerConditions: text("triggerConditions"),
    triggeredActor: text("triggeredActor"),
    economicImpact: text("economicImpact"),
    confirmationReason: text("confirmationReason"),
    rejectionReason: text("rejectionReason"),
    recommendation: text("recommendation"),
    note: text("note"),
    humanStatus: text("humanStatus"),
    // Decode JSON at the store boundary so malformed agent output stays isolated.
    sourceLocations: text("sourceLocations"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    index("SessionFinding_createdAt_idx").on(table.createdAt),
    index("SessionFinding_duplicateOfId_idx").on(table.duplicateOfId),
    index("SessionFinding_status_idx").on(table.status),
    index("SessionFinding_sessionId_idx").on(table.sessionId),
  ],
);

export const sessionFindingReviews = sqliteTable(
  "SessionFindingReview",
  {
    id: text("id").primaryKey().notNull(),
    sessionId: text("sessionId")
      .notNull()
      .references(() => auditSessions.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    findingKey: text("findingKey").notNull(),
    action: text("action").notNull(),
    reviewedAt: text("reviewedAt").notNull(),
  },
  (table) => [
    index("SessionFindingReview_findingKey_idx").on(table.findingKey),
    index("SessionFindingReview_sessionId_idx").on(table.sessionId),
    index("SessionFindingReview_reviewedAt_idx").on(table.reviewedAt),
  ],
);

export const sessionGroups = sqliteTable(
  "SessionGroup",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    createdAt: text("createdAt").notNull(),
    reviewMinSeverity: text("reviewMinSeverity").notNull().default("high"),
  },
  (table) => [index("SessionGroup_createdAt_idx").on(table.createdAt)],
);

export const sessionGroupMembers = sqliteTable(
  "SessionGroupMember",
  {
    groupId: text("groupId")
      .notNull()
      .references(() => sessionGroups.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    sessionId: text("sessionId")
      .notNull()
      .references(() => auditSessions.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    index: integer("index").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("SessionGroupMember_groupId_index_key").on(
      table.groupId,
      table.index,
    ),
    index("SessionGroupMember_sessionId_idx").on(table.sessionId),
  ],
);

export const uploads = sqliteTable("Upload", {
  id: text("id").primaryKey().notNull(),
  targetPath: text("targetPath").notNull(),
  workflowId: text("workflowId").notNull().default("main-audit"),
  projectName: text("projectName"),
  metadata: text("metadata"),
  source: text("source"),
});

export const sessionQueueItems = sqliteTable(
  "SessionQueueItem",
  {
    id: text("id").primaryKey().notNull(),
    key: text("key").notNull(),
    sessionId: text("sessionId").notNull(),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    claimedAt: text("claimedAt"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("SessionQueueItem_sessionId_unique").on(table.sessionId),
    index("SessionQueueItem_status_createdAt_idx").on(
      table.status,
      table.createdAt,
    ),
    index("SessionQueueItem_key_createdAt_idx").on(table.key, table.createdAt),
  ],
);

export const queueSettings = sqliteTable("QueueSetting", {
  key: text("key").primaryKey(),
  concurrency: integer("concurrency").notNull().default(1),
});

export type AuditSessionRow = typeof auditSessions.$inferSelect;
export type SessionFindingRow = typeof sessionFindings.$inferSelect;
export type SessionFindingInsert = typeof sessionFindings.$inferInsert;
export type SessionFindingReviewRow = typeof sessionFindingReviews.$inferSelect;
export type UploadRow = typeof uploads.$inferSelect;
