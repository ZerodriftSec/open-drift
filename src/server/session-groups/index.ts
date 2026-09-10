import { normalizeAgentId } from "@/audit/agent/registry";
import {
  AuditStatus,
  DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
  HumanFindingStatus,
  isFindingAtOrAboveReviewSeverity,
  severityValues,
  Severity,
  type AuditSessionSnapshot,
  type FindingReviewSeverity,
} from "@/audit/session/types";
import { WorkflowDefinition } from "@/audit/workflow";
import {
  getWorkflowDefinition,
  type ResolvedWorkflowDefinition,
} from "@/server/workflows";
import {
  normalizeTaskMetadataWithSource,
  type TaskMetadata,
} from "@/lib/task-metadata";
import {
  createAndStartPathSession,
  startUploadSessionFromUpload,
} from "@/server/uploads";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "../db";
import {
  auditSessions,
  SessionFindingStatus,
  sessionFindings,
  sessionGroupMembers,
  sessionGroups,
} from "../db/schema";
import {
  listSessionFindingSeverityCountsFromDb,
  listSessionHumanConfirmedFindingCountsFromDb,
  listSessionNeedsReviewFindingCountsFromDb,
  listSessionStatesByIdsFromDb,
  readSessionStateFromDb,
} from "../db/store";
import { normalizePagination, type PaginatedList } from "@/lib/pagination";
import { deleteSession } from "@/server/sessions";

const SESSION_GROUP_NAME_MAX_LENGTH = 120;
const SESSION_GROUP_RANDOM_ID_LENGTH = 12;
export const SESSION_GROUP_MEMBER_MAX = 500;

export type SessionGroupMemberInput =
  | {
      projectName?: string;
      projectSource: "local";
      targetPath: string;
    }
  | {
      excludedPaths?: string[];
      projectName?: string;
      projectSource: "upload";
      uploadId: string;
    };

export type CreateSessionGroupInput = {
  agentIds: readonly string[];
  groupName: string;
  metadata?: unknown;
  projectRoot?: string;
  sessions: readonly unknown[];
  source?: string;
  workflowId: string;
};

export type CreateSessionGroupResult = {
  created: Array<{
    index: number;
    sessionId: string;
    status: "queued";
  }>;
  failed: Array<{
    error: string;
    index: number;
  }>;
  groupId: string;
  groupName: string;
};

export type SessionGroupAssignment = {
  groupId: string;
  groupName: string;
  index: number;
};

export type SessionGroupDetails = {
  createdAt: string;
  groupId: string;
  groupName: string;
  reviewMinSeverity: FindingReviewSeverity;
  sessions: Array<{
    index: number;
    session: AuditSessionSnapshot;
  }>;
};

export type DeleteSessionGroupResult = {
  deleted: true;
  deletedSessionIds: string[];
  groupId: string;
};

export type UpdateSessionGroupReviewMinSeverityResult = {
  groupId: string;
  reviewMinSeverity: FindingReviewSeverity;
};

export type SessionFindingSeverityCounts = {
  critical: number;
  high: number;
  info: number;
  low: number;
  medium: number;
};

export type SessionGroupHierarchySession = AuditSessionSnapshot & {
  findingSeverityCounts: SessionFindingSeverityCounts;
  humanConfirmedFindingCount: number;
  needsReviewFindingCount: number;
};

export type SessionGroupHierarchyItem =
  | {
      activeSessionCount: number;
      agentIds: string[];
      completedSessionCount: number;
      createdAt: string;
      groupId: string;
      groupName: string;
      humanConfirmedFindingCount: number;
      kind: "group";
      needsReviewFindingCount: number;
      needsReviewSessionCount: number;
      reviewMinSeverity: FindingReviewSeverity;
      sessionCount: number;
      workflowLabels: string[];
    }
  | {
      kind: "session";
      session: SessionGroupHierarchySession;
    };

export type SessionGroupHierarchyPage =
  PaginatedList<SessionGroupHierarchyItem> & {
    groupCount: number;
    sessionCount: number;
    ungroupedSessionCount: number;
  };

export type SessionGroupHierarchyView = "groups" | "sessions";
export type SessionGroupMemberView = "all" | "human-confirmed" | "needs-review";

export type SessionGroupMemberPage =
  PaginatedList<SessionGroupHierarchySession>;

export type SessionGroupHierarchyOptions = {
  page?: number;
  pageSize?: number;
  view?: SessionGroupHierarchyView;
};

export type SessionGroupMemberPageOptions = {
  groupId: string;
  page?: number;
  pageSize?: number;
  view?: SessionGroupMemberView;
};

export async function createSessionGroup(
  input: CreateSessionGroupInput,
): Promise<CreateSessionGroupResult> {
  const groupName = normalizedGroupName(input.groupName);
  if (
    input.sessions.length < 1 ||
    input.sessions.length > SESSION_GROUP_MEMBER_MAX
  ) {
    throw new Error(
      `sessions must contain between 1 and ${SESSION_GROUP_MEMBER_MAX} items.`,
    );
  }
  const workflow = await getWorkflowDefinition(
    requiredString(input.workflowId, "workflowId"),
  );
  const agentIds = normalizedAgentIds(input.agentIds, workflow);
  const metadata = normalizeTaskMetadataWithSource(
    input.metadata,
    input.source,
  );
  const groupId = createSessionGroupId();
  const createdAt = new Date().toISOString();
  const db = await getDb();

  await db
    .insert(sessionGroups)
    .values({
      createdAt,
      id: groupId,
      name: groupName,
    })
    .run();

  const created: CreateSessionGroupResult["created"] = [];
  const failed: CreateSessionGroupResult["failed"] = [];

  for (const [index, rawMember] of input.sessions.entries()) {
    let result: Awaited<ReturnType<typeof createMemberSession>> | undefined;
    try {
      const member = parseMember(rawMember);
      result = await createMemberSession({
        agentIds,
        member,
        metadata,
        projectRoot: input.projectRoot ?? process.cwd(),
        workflowId: workflow.id,
      });
    } catch (error) {
      failed.push({ error: errorMessage(error), index });
      continue;
    }

    await db
      .insert(sessionGroupMembers)
      .values({
        createdAt: new Date().toISOString(),
        groupId,
        index,
        sessionId: result.sessionId,
      })
      .run();

    created.push({ index, sessionId: result.sessionId, status: "queued" });
  }

  if (created.length === 0) {
    await db.delete(sessionGroups).where(eq(sessionGroups.id, groupId)).run();
    throw new Error("No project successfully created a Session Group.");
  }

  return {
    created,
    failed,
    groupId,
    groupName,
  };
}

export async function addSessionToNamedGroup({
  groupName,
  sessionId,
}: {
  groupName: string;
  sessionId: string;
}): Promise<SessionGroupAssignment> {
  const normalizedName = normalizedGroupName(groupName);
  const normalizedSessionId = requiredString(sessionId, "sessionId");
  const db = await getDb();
  const session = await db
    .select({ id: auditSessions.id })
    .from(auditSessions)
    .where(eq(auditSessions.id, normalizedSessionId))
    .get();
  if (!session) {
    throw new Error(`Session not found: ${normalizedSessionId}`);
  }

  const existingMembership = await db
    .select({
      groupId: sessionGroupMembers.groupId,
      index: sessionGroupMembers.index,
    })
    .from(sessionGroupMembers)
    .where(eq(sessionGroupMembers.sessionId, normalizedSessionId))
    .get();
  if (existingMembership) {
    const existingGroup = await db
      .select()
      .from(sessionGroups)
      .where(eq(sessionGroups.id, existingMembership.groupId))
      .get();
    if (existingGroup?.name !== normalizedName) {
      throw new Error(
        `Session already belongs to another Group: ${existingGroup?.name ?? existingMembership.groupId}`,
      );
    }
    return {
      groupId: existingMembership.groupId,
      groupName: normalizedName,
      index: existingMembership.index,
    };
  }

  let group = await db
    .select()
    .from(sessionGroups)
    .where(eq(sessionGroups.name, normalizedName))
    .orderBy(asc(sessionGroups.createdAt))
    .get();
  if (!group) {
    group = {
      createdAt: new Date().toISOString(),
      id: createSessionGroupId(),
      name: normalizedName,
      reviewMinSeverity: DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
    };
    await db.insert(sessionGroups).values(group).run();
  }

  const memberships = await db
    .select({ index: sessionGroupMembers.index })
    .from(sessionGroupMembers)
    .where(eq(sessionGroupMembers.groupId, group.id));
  const index =
    memberships.reduce(
      (highest, membership) => Math.max(highest, membership.index),
      -1,
    ) + 1;
  await db
    .insert(sessionGroupMembers)
    .values({
      createdAt: new Date().toISOString(),
      groupId: group.id,
      index,
      sessionId: normalizedSessionId,
    })
    .run();

  return { groupId: group.id, groupName: group.name, index };
}

export async function listSessionGroupHierarchyPage({
  page,
  pageSize,
  view = "sessions",
}: SessionGroupHierarchyOptions = {}): Promise<SessionGroupHierarchyPage> {
  const db = await getDb();
  const [groupCount, sessionCount, ungroupedSessionCount] = await Promise.all([
    db.$count(sessionGroups),
    db.$count(auditSessions),
    countUngroupedSessions(),
  ]);
  const totalCount = view === "groups" ? groupCount : ungroupedSessionCount;
  const { offset, ...pagination } = normalizePagination({
    page,
    pageSize,
    totalCount,
  });

  if (view === "groups") {
    const groups = await db
      .select()
      .from(sessionGroups)
      .orderBy(desc(sessionGroups.createdAt), desc(sessionGroups.id))
      .limit(pagination.pageSize)
      .offset(offset);

    return {
      ...pagination,
      groupCount,
      items: await sessionGroupSummaries(groups),
      sessionCount,
      ungroupedSessionCount,
    };
  }

  const sessions = await db
    .select({ sessionId: auditSessions.id })
    .from(auditSessions)
    .leftJoin(
      sessionGroupMembers,
      eq(sessionGroupMembers.sessionId, auditSessions.id),
    )
    .where(isNull(sessionGroupMembers.sessionId))
    .orderBy(desc(auditSessions.createdAt), desc(auditSessions.id))
    .limit(pagination.pageSize)
    .offset(offset);
  const sessionsById = await sessionHierarchySessionsById(
    sessions.map(({ sessionId }) => sessionId),
  );

  return {
    ...pagination,
    groupCount,
    items: sessions.map(({ sessionId }) => {
      const session = sessionsById.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      return { kind: "session", session };
    }),
    sessionCount,
    ungroupedSessionCount,
  };
}

export async function listSessionGroupMemberPage({
  groupId,
  page,
  pageSize,
  view = "all",
}: SessionGroupMemberPageOptions): Promise<SessionGroupMemberPage> {
  const normalizedGroupId = requiredString(groupId, "groupId");
  const db = await getDb();
  const reviewMinSeverity =
    await getSessionGroupReviewMinSeverity(normalizedGroupId);
  const reviewCounts =
    view === "needs-review"
      ? await listGroupNeedsReviewCounts(
          new Map([[normalizedGroupId, reviewMinSeverity]]),
        )
      : undefined;
  const humanConfirmedCounts =
    view === "human-confirmed"
      ? await listGroupHumanConfirmedCounts([normalizedGroupId])
      : undefined;
  const reviewSessionCounts = reviewCounts?.get(normalizedGroupId);
  const humanConfirmedSessionCounts =
    humanConfirmedCounts?.get(normalizedGroupId);
  const totalCount =
    view === "needs-review"
      ? (reviewSessionCounts?.size ?? 0)
      : view === "human-confirmed"
        ? (humanConfirmedSessionCounts?.size ?? 0)
        : await countSessionGroupMembers(normalizedGroupId);
  const { offset, ...pagination } = normalizePagination({
    page,
    pageSize,
    totalCount,
  });
  const memberRows =
    view === "needs-review"
      ? await listNeedsReviewMemberPage({
          groupId: normalizedGroupId,
          offset,
          pageSize: pagination.pageSize,
          reviewCounts: reviewSessionCounts ?? new Map(),
        })
      : view === "human-confirmed"
        ? await listHumanConfirmedMemberPage({
            groupId: normalizedGroupId,
            humanConfirmedCounts: humanConfirmedSessionCounts ?? new Map(),
            offset,
            pageSize: pagination.pageSize,
          })
        : await db
            .select({ sessionId: sessionGroupMembers.sessionId })
            .from(sessionGroupMembers)
            .innerJoin(
              auditSessions,
              eq(sessionGroupMembers.sessionId, auditSessions.id),
            )
            .where(eq(sessionGroupMembers.groupId, normalizedGroupId))
            .orderBy(desc(auditSessions.createdAt), desc(auditSessions.id))
            .limit(pagination.pageSize)
            .offset(offset);
  const sessionsById = await sessionHierarchySessionsById(
    memberRows.map(({ sessionId }) => sessionId),
    reviewMinSeverity,
  );

  return {
    ...pagination,
    items: memberRows.flatMap(({ sessionId }) => {
      const session = sessionsById.get(sessionId);
      return session ? [session] : [];
    }),
  };
}

async function sessionHierarchySessionsById(
  sessionIds: string[],
  reviewMinSeverity: FindingReviewSeverity = DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
) {
  const states = await listSessionStatesByIdsFromDb(sessionIds);
  const loadedSessionIds = states.map((session) => session.sessionId);
  const [severityRows, humanConfirmedRows, needsReviewRows] = await Promise.all(
    [
      listSessionFindingSeverityCountsFromDb(loadedSessionIds),
      listSessionHumanConfirmedFindingCountsFromDb(loadedSessionIds),
      listSessionNeedsReviewFindingCountsFromDb(
        loadedSessionIds,
        reviewMinSeverity,
      ),
    ],
  );
  const severityCountsBySession = new Map(
    states.map((session) => [
      session.sessionId,
      emptySessionFindingSeverityCounts(),
    ]),
  );
  const humanConfirmedCountsBySession = new Map(
    humanConfirmedRows.map((row) => [row.sessionId, row.count]),
  );
  const needsReviewCountsBySession = new Map(
    needsReviewRows.map((row) => [row.sessionId, row.count]),
  );
  for (const row of severityRows) {
    if (!isFindingSeverity(row.severity)) continue;
    const counts = severityCountsBySession.get(row.sessionId);
    if (counts) counts[row.severity] = row.count;
  }
  const sessionsById = new Map(
    states.map((session) => [
      session.sessionId,
      {
        ...session,
        findingSeverityCounts:
          severityCountsBySession.get(session.sessionId) ??
          emptySessionFindingSeverityCounts(),
        humanConfirmedFindingCount:
          humanConfirmedCountsBySession.get(session.sessionId) ?? 0,
        needsReviewFindingCount:
          needsReviewCountsBySession.get(session.sessionId) ?? 0,
      },
    ]),
  );

  return sessionsById;
}

async function countUngroupedSessions() {
  const row = await (
    await getDb()
  )
    .select({ count: sql<number>`count(*)` })
    .from(auditSessions)
    .leftJoin(
      sessionGroupMembers,
      eq(sessionGroupMembers.sessionId, auditSessions.id),
    )
    .where(isNull(sessionGroupMembers.sessionId))
    .get();
  return Number(row?.count ?? 0);
}

async function countSessionGroupMembers(groupId: string) {
  const row = await (
    await getDb()
  )
    .select({ count: sql<number>`count(*)` })
    .from(sessionGroupMembers)
    .where(eq(sessionGroupMembers.groupId, groupId))
    .get();
  return Number(row?.count ?? 0);
}

type SessionGroupSummarySource = {
  createdAt: string;
  id: string;
  name: string;
  reviewMinSeverity: string;
};

async function sessionGroupSummaries(groups: SessionGroupSummarySource[]) {
  if (groups.length === 0) return [];

  const groupIds = groups.map(({ id }) => id);
  const reviewMinSeverities = new Map(
    groups.map((group) => [
      group.id,
      storedSessionGroupReviewMinSeverity(group.reviewMinSeverity),
    ]),
  );
  const [members, humanConfirmedCounts, needsReviewCounts] = await Promise.all([
    (await getDb())
      .select({
        agents: auditSessions.agents,
        groupId: sessionGroupMembers.groupId,
        sessionId: auditSessions.id,
        status: auditSessions.status,
        workflow: auditSessions.workflow,
        workflowId: auditSessions.workflowId,
      })
      .from(sessionGroupMembers)
      .innerJoin(
        auditSessions,
        eq(sessionGroupMembers.sessionId, auditSessions.id),
      )
      .where(inArray(sessionGroupMembers.groupId, groupIds))
      .orderBy(
        asc(sessionGroupMembers.groupId),
        asc(sessionGroupMembers.index),
      ),
    listGroupHumanConfirmedCounts(groupIds),
    listGroupNeedsReviewCounts(reviewMinSeverities),
  ]);
  const membersByGroupId = new Map<string, typeof members>();
  for (const member of members) {
    const groupMembers = membersByGroupId.get(member.groupId) ?? [];
    groupMembers.push(member);
    membersByGroupId.set(member.groupId, groupMembers);
  }

  return groups.map((group): SessionGroupHierarchyItem => {
    const groupMembers = membersByGroupId.get(group.id) ?? [];
    const groupNeedsReviewCounts = needsReviewCounts.get(group.id) ?? new Map();
    const agentIds = new Set<string>();
    const workflowLabels = new Set<string>();
    for (const member of groupMembers) {
      for (const agentId of stringArrayValue(member.agents)) {
        agentIds.add(agentId);
      }
      workflowLabels.add(workflowLabel(member.workflow, member.workflowId));
    }

    return {
      activeSessionCount: groupMembers.filter(({ status }) =>
        isActiveSessionStatus(status),
      ).length,
      agentIds: [...agentIds],
      completedSessionCount: groupMembers.filter(
        ({ status }) => status === AuditStatus.COMPLETED,
      ).length,
      createdAt: group.createdAt,
      groupId: group.id,
      groupName: group.name,
      humanConfirmedFindingCount: [
        ...(humanConfirmedCounts.get(group.id)?.values() ?? []),
      ].reduce((total, count) => total + count, 0),
      kind: "group",
      needsReviewFindingCount: [...groupNeedsReviewCounts.values()].reduce(
        (total, summary) => total + summary.count,
        0,
      ),
      needsReviewSessionCount: groupNeedsReviewCounts.size,
      reviewMinSeverity:
        reviewMinSeverities.get(group.id) ??
        DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
      sessionCount: groupMembers.length,
      workflowLabels: [...workflowLabels],
    };
  });
}

async function listGroupNeedsReviewCounts(
  reviewMinSeverities: ReadonlyMap<string, FindingReviewSeverity>,
) {
  const countsByGroupId = new Map<
    string,
    Map<string, NeedsReviewSessionSummary>
  >();
  const groupIds = [...reviewMinSeverities.keys()];
  if (groupIds.length === 0) return countsByGroupId;

  const reviewSeverities = severityValues.filter((severity) =>
    [...reviewMinSeverities.values()].some((reviewMinSeverity) =>
      isFindingAtOrAboveReviewSeverity(severity, reviewMinSeverity),
    ),
  );
  const rows = await (
    await getDb()
  )
    .select({
      groupId: sessionGroupMembers.groupId,
      sessionId: sessionFindings.sessionId,
      severity: sessionFindings.severity,
    })
    .from(sessionGroupMembers)
    .innerJoin(
      sessionFindings,
      eq(sessionGroupMembers.sessionId, sessionFindings.sessionId),
    )
    .where(
      and(
        inArray(sessionGroupMembers.groupId, groupIds),
        eq(sessionFindings.status, SessionFindingStatus.CONFIRMED),
        isNull(sessionFindings.humanStatus),
        inArray(sessionFindings.severity, reviewSeverities),
      ),
    );
  for (const row of rows) {
    const reviewMinSeverity = reviewMinSeverities.get(row.groupId);
    if (
      !reviewMinSeverity ||
      !isFindingAtOrAboveReviewSeverity(
        row.severity as FindingReviewSeverity,
        reviewMinSeverity,
      )
    ) {
      continue;
    }
    const groupCounts = countsByGroupId.get(row.groupId) ?? new Map();
    const current = groupCounts.get(row.sessionId);
    groupCounts.set(row.sessionId, {
      count: (current?.count ?? 0) + 1,
      highestSeverityRank: Math.max(
        current?.highestSeverityRank ?? 0,
        findingSeverityRank(row.severity as FindingReviewSeverity),
      ),
    });
    countsByGroupId.set(row.groupId, groupCounts);
  }
  return countsByGroupId;
}

async function listGroupHumanConfirmedCounts(groupIds: string[]) {
  const countsByGroupId = new Map<string, Map<string, number>>();
  if (groupIds.length === 0) return countsByGroupId;

  const rows = await (
    await getDb()
  )
    .select({
      groupId: sessionGroupMembers.groupId,
      sessionId: sessionFindings.sessionId,
    })
    .from(sessionGroupMembers)
    .innerJoin(
      sessionFindings,
      eq(sessionGroupMembers.sessionId, sessionFindings.sessionId),
    )
    .where(
      and(
        inArray(sessionGroupMembers.groupId, groupIds),
        inArray(sessionFindings.status, [
          SessionFindingStatus.PENDING,
          SessionFindingStatus.CONFIRMED,
          SessionFindingStatus.ONCHAIN_CONFIRMED,
        ]),
        eq(sessionFindings.humanStatus, HumanFindingStatus.TP),
      ),
    );
  for (const row of rows) {
    const groupCounts = countsByGroupId.get(row.groupId) ?? new Map();
    groupCounts.set(row.sessionId, (groupCounts.get(row.sessionId) ?? 0) + 1);
    countsByGroupId.set(row.groupId, groupCounts);
  }
  return countsByGroupId;
}

async function listHumanConfirmedMemberPage({
  groupId,
  humanConfirmedCounts,
  offset,
  pageSize,
}: {
  groupId: string;
  humanConfirmedCounts: Map<string, number>;
  offset: number;
  pageSize: number;
}) {
  if (humanConfirmedCounts.size === 0) return [];

  const rows = await (
    await getDb()
  )
    .select({
      createdAt: auditSessions.createdAt,
      sessionId: sessionGroupMembers.sessionId,
    })
    .from(sessionGroupMembers)
    .innerJoin(
      auditSessions,
      eq(sessionGroupMembers.sessionId, auditSessions.id),
    )
    .where(eq(sessionGroupMembers.groupId, groupId));
  return rows
    .filter(({ sessionId }) => humanConfirmedCounts.has(sessionId))
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.sessionId.localeCompare(left.sessionId),
    )
    .slice(offset, offset + pageSize)
    .map(({ sessionId }) => ({ sessionId }));
}

async function listNeedsReviewMemberPage({
  groupId,
  offset,
  pageSize,
  reviewCounts,
}: {
  groupId: string;
  offset: number;
  pageSize: number;
  reviewCounts: Map<string, NeedsReviewSessionSummary>;
}) {
  if (reviewCounts.size === 0) return [];

  const rows = await (
    await getDb()
  )
    .select({
      createdAt: auditSessions.createdAt,
      sessionId: auditSessions.id,
    })
    .from(sessionGroupMembers)
    .innerJoin(
      auditSessions,
      eq(sessionGroupMembers.sessionId, auditSessions.id),
    )
    .where(eq(sessionGroupMembers.groupId, groupId));
  return rows
    .filter(({ sessionId }) => reviewCounts.has(sessionId))
    .sort(
      (left, right) =>
        (reviewCounts.get(right.sessionId)?.highestSeverityRank ?? 0) -
          (reviewCounts.get(left.sessionId)?.highestSeverityRank ?? 0) ||
        (reviewCounts.get(right.sessionId)?.count ?? 0) -
          (reviewCounts.get(left.sessionId)?.count ?? 0) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.sessionId.localeCompare(left.sessionId),
    )
    .slice(offset, offset + pageSize)
    .map(({ sessionId }) => ({ sessionId }));
}

type NeedsReviewSessionSummary = {
  count: number;
  highestSeverityRank: number;
};

const findingSeverityRanks: Record<FindingReviewSeverity, number> = {
  [Severity.INFO]: 0,
  [Severity.LOW]: 1,
  [Severity.MEDIUM]: 2,
  [Severity.HIGH]: 3,
  [Severity.CRITICAL]: 4,
};

function findingSeverityRank(severity: FindingReviewSeverity) {
  return findingSeverityRanks[severity] ?? 0;
}

function isActiveSessionStatus(status: string) {
  return status === AuditStatus.QUEUED || status === AuditStatus.RUNNING;
}

function stringArrayValue(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function workflowLabel(serialized: string, workflowId: string) {
  try {
    return WorkflowDefinition.deserialize(serialized).name ?? workflowId;
  } catch {
    return workflowId;
  }
}

function emptySessionFindingSeverityCounts(): SessionFindingSeverityCounts {
  return { critical: 0, high: 0, info: 0, low: 0, medium: 0 };
}

function isFindingSeverity(
  value: string,
): value is keyof SessionFindingSeverityCounts {
  return (
    value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "info"
  );
}

export async function getSessionReviewMinSeverity(
  sessionId: string,
): Promise<FindingReviewSeverity> {
  const normalizedSessionId = requiredString(sessionId, "sessionId");
  const row = await (
    await getDb()
  )
    .select({ reviewMinSeverity: sessionGroups.reviewMinSeverity })
    .from(sessionGroupMembers)
    .innerJoin(sessionGroups, eq(sessionGroupMembers.groupId, sessionGroups.id))
    .where(eq(sessionGroupMembers.sessionId, normalizedSessionId))
    .orderBy(asc(sessionGroupMembers.createdAt))
    .get();

  return row
    ? storedSessionGroupReviewMinSeverity(row.reviewMinSeverity)
    : DEFAULT_FINDING_REVIEW_MIN_SEVERITY;
}

export async function updateSessionGroupReviewMinSeverity({
  groupId,
  reviewMinSeverity,
}: {
  groupId: string;
  reviewMinSeverity: unknown;
}): Promise<UpdateSessionGroupReviewMinSeverityResult> {
  const normalizedGroupId = requiredString(groupId, "groupId");
  const normalizedReviewMinSeverity =
    requiredFindingReviewSeverity(reviewMinSeverity);
  const db = await getDb();
  const group = await db
    .select({ id: sessionGroups.id })
    .from(sessionGroups)
    .where(eq(sessionGroups.id, normalizedGroupId))
    .get();
  if (!group) {
    throw new Error(`Session Group not found: ${normalizedGroupId}`);
  }

  await db
    .update(sessionGroups)
    .set({ reviewMinSeverity: normalizedReviewMinSeverity })
    .where(eq(sessionGroups.id, normalizedGroupId))
    .run();
  return {
    groupId: normalizedGroupId,
    reviewMinSeverity: normalizedReviewMinSeverity,
  };
}

async function getSessionGroupReviewMinSeverity(groupId: string) {
  const row = await (
    await getDb()
  )
    .select({ reviewMinSeverity: sessionGroups.reviewMinSeverity })
    .from(sessionGroups)
    .where(eq(sessionGroups.id, groupId))
    .get();
  if (!row) {
    throw new Error(`Session Group not found: ${groupId}`);
  }
  return storedSessionGroupReviewMinSeverity(row.reviewMinSeverity);
}

export async function getSessionGroup(
  groupId: string,
): Promise<SessionGroupDetails | null> {
  const normalizedGroupId = requiredString(groupId, "groupId");
  const db = await getDb();
  const group = await db
    .select()
    .from(sessionGroups)
    .where(eq(sessionGroups.id, normalizedGroupId))
    .get();

  if (!group) {
    return null;
  }

  const members = await db
    .select({
      index: sessionGroupMembers.index,
      sessionId: sessionGroupMembers.sessionId,
    })
    .from(sessionGroupMembers)
    .innerJoin(
      auditSessions,
      eq(sessionGroupMembers.sessionId, auditSessions.id),
    )
    .where(eq(sessionGroupMembers.groupId, group.id))
    .orderBy(asc(sessionGroupMembers.index));
  const sessions = await Promise.all(
    members.map(async (member) => ({
      index: member.index,
      session: await readSessionStateFromDb(member.sessionId),
    })),
  );

  return {
    createdAt: group.createdAt,
    groupId: group.id,
    groupName: group.name,
    reviewMinSeverity: storedSessionGroupReviewMinSeverity(
      group.reviewMinSeverity,
    ),
    sessions: sessions.flatMap((member) =>
      member.session ? [{ index: member.index, session: member.session }] : [],
    ),
  };
}

export async function deleteSessionGroup({
  groupId,
  projectRoot = process.cwd(),
}: {
  groupId: string;
  projectRoot?: string;
}): Promise<DeleteSessionGroupResult> {
  const normalizedGroupId = requiredString(groupId, "groupId");
  const group = await getSessionGroup(normalizedGroupId);
  if (!group) {
    throw new Error(`Session Group not found: ${normalizedGroupId}`);
  }

  const activeSessionIds = group.sessions
    .map(({ session }) => session)
    .filter(
      ({ status }) =>
        status === AuditStatus.QUEUED || status === AuditStatus.RUNNING,
    )
    .map(({ sessionId }) => sessionId);
  if (activeSessionIds.length > 0) {
    throw new Error(
      `Session Group contains running Sessions and cannot be deleted: ${activeSessionIds.join(", ")}`,
    );
  }

  const deletedSessionIds = group.sessions.map(
    ({ session }) => session.sessionId,
  );
  await Promise.all(
    deletedSessionIds.map((sessionId) =>
      deleteSession({ projectRoot, sessionId }),
    ),
  );
  await (
    await getDb()
  )
    .delete(sessionGroups)
    .where(eq(sessionGroups.id, normalizedGroupId))
    .run();

  return { deleted: true, deletedSessionIds, groupId: normalizedGroupId };
}

async function createMemberSession({
  agentIds,
  member,
  metadata,
  projectRoot,
  workflowId,
}: {
  agentIds: readonly string[];
  member: SessionGroupMemberInput;
  metadata?: TaskMetadata;
  projectRoot: string;
  workflowId: string;
}) {
  if (member.projectSource === "local") {
    return createAndStartPathSession({
      agentIds,
      metadata,
      projectName: member.projectName,
      projectRoot,
      targetPath: member.targetPath,
      workflowId,
    });
  }

  return startUploadSessionFromUpload({
    agentIds,
    excludedPaths: member.excludedPaths,
    metadata,
    projectName: member.projectName,
    projectRoot,
    uploadId: member.uploadId,
    workflowId,
  });
}

function normalizedGroupName(value: string) {
  const groupName = requiredString(value, "groupName");
  if (groupName.length > SESSION_GROUP_NAME_MAX_LENGTH) {
    throw new Error(
      `groupName cannot exceed ${SESSION_GROUP_NAME_MAX_LENGTH} characters.`,
    );
  }
  return groupName;
}

function normalizedAgentIds(
  value: readonly string[],
  workflow: ResolvedWorkflowDefinition,
) {
  if (!Array.isArray(value)) {
    throw new Error("agentIds must be an array of Agent IDs.");
  }

  const agentIds = value.map((agentId) =>
    normalizeAgentId(requiredString(agentId, "agentIds")),
  );
  if (agentIds.length !== workflow.stages.length) {
    throw new Error(
      `Workflow ${workflow.name} has ${workflow.stages.length} stages, so agentIds must contain ${workflow.stages.length} Agents.`,
    );
  }
  return agentIds;
}

function parseMember(value: unknown): SessionGroupMemberInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Session parameters.");
  }

  const member = value as Record<string, unknown>;
  const projectSource = optionalString(member.projectSource);
  const projectName = optionalString(member.projectName);

  if (projectSource === "local") {
    return {
      projectName,
      projectSource,
      targetPath: requiredString(member.targetPath, "targetPath"),
    };
  }

  if (projectSource === "upload") {
    return {
      excludedPaths: optionalStringArray(member.excludedPaths),
      projectName,
      projectSource,
      uploadId: requiredString(member.uploadId, "uploadId"),
    };
  }

  throw new Error("projectSource must be local or upload.");
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("excludedPaths must be an array of strings.");
  }

  return value.map((item) => requiredString(item, "excludedPaths"));
}

function requiredString(value: unknown, field: string) {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`Missing ${field}`);
  }
  return normalized;
}

function requiredFindingReviewSeverity(value: unknown): FindingReviewSeverity {
  if (
    typeof value === "string" &&
    (severityValues as readonly string[]).includes(value)
  ) {
    return value as FindingReviewSeverity;
  }
  throw new Error(
    `reviewMinSeverity must be one of: ${severityValues.join(", ")}.`,
  );
}

function storedSessionGroupReviewMinSeverity(value: string) {
  try {
    return requiredFindingReviewSeverity(value);
  } catch {
    return DEFAULT_FINDING_REVIEW_MIN_SEVERITY;
  }
}

function createSessionGroupId() {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = randomBytes(Math.ceil(SESSION_GROUP_RANDOM_ID_LENGTH / 2))
    .toString("hex")
    .slice(0, SESSION_GROUP_RANDOM_ID_LENGTH);
  return `session-group-${timestamp}-${suffix}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
