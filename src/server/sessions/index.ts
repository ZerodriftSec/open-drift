import type { AgentMessage, AgentTurnStatus } from "@/audit/agent/types";
import {
  createUsageParser,
  listAgentDefinitions,
} from "@/audit/agent/registry";
import type { BaseUsage, UsageObservation } from "@/audit/agent/usage";
import {
  HumanFindingStatus,
  type AuditSessionSnapshot,
  type FindingSourceLocation,
} from "@/audit/session/types";
import { normalizePagination, type PaginatedList } from "@/lib/pagination";
import { SessionFindingStatus } from "@/server/db/schema";
import { findingNoteUpdateSchema } from "@/schemas/finding";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  appendSessionFindingReviewToDb,
  countSessionStatesInDb,
  dequeueSessionInDb,
  deleteSessionStateFromDb,
  getSessionQueue,
  listCanonicalSessionFindingsFromDb,
  listSessionFindingReviewsFromDb,
  listSessionFindingsFromDb,
  listSessionStatesFromDb,
  readSessionStateFromDb,
  updateSessionFindingHumanStatusInDb,
  updateSessionFindingNoteInDb,
  updateSessionWorkflowSnapshotInDb,
} from "../db/store";
import { getWorkflowDefinition } from "../workflows";

export { AuditStatus } from "@/audit/session/types";
export type { AuditSessionSnapshot } from "@/audit/session/types";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type FindingSource = "confirmed" | "pending";
export type HumanFindingReviewAction = "confirm" | "pass" | "reset";
export type SessionFindingReviewDecision = Exclude<
  HumanFindingReviewAction,
  "reset"
>;
export type { HumanFindingStatus } from "@/audit/session/types";

const SESSION_ARTIFACT_FILE_PREVIEW_MAX_BYTES = 512 * 1024;
const SESSION_ARTIFACT_FILE_BINARY_SAMPLE_BYTES = 4096;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_STORE_METHOD = 0;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION_MADE_BY_UNIX = 0x0314;
const ZIP_VERSION_NEEDED = 20;
const ZIP_MAX_UINT16 = 0xffff;
const ZIP_MAX_UINT32 = 0xffffffff;
const SESSION_ARTIFACT_ARCHIVE_EXCLUDED_NAMES = new Set([
  ".agent",
  ".agents",
  ".gemini",
]);
const SESSION_LOG_SUMMARY_TAIL_BYTES = 512 * 1024;

export type SessionArtifactTreeEntry = {
  name: string;
  path: string;
  size?: number;
  type: "dir" | "file";
};

export type SessionArtifactFileContent = {
  content: string;
  encoding: "utf-8";
  maxBytes: number;
  name: string;
  path: string;
  size: number;
  truncated: boolean;
};

type SessionArtifactTreeOptions = {
  projectRoot?: string;
  sessionId: string;
  treePath?: string;
};
type SessionArtifactFileOptions = {
  filePath: string;
  projectRoot?: string;
  sessionId: string;
};
type SessionArtifactArchiveOptions = {
  projectRoot?: string;
  sessionId: string;
  treePath?: string;
};
export type SessionArtifactArchive = {
  fileName: string;
  mimeType: "application/zip";
  stream: ReadableStream<Uint8Array>;
};
export type SessionArtifactFileDownload = {
  fileName: string;
  mimeType: "application/octet-stream";
  stream: ReadableStream<Uint8Array>;
};
type ZipArchiveItem = {
  absolutePath?: string;
  archivePath: string;
  directory: boolean;
  mtime: Date;
};
type ZipCentralRecord = ZipArchiveItem & {
  compressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  uncompressedSize: number;
  usesDataDescriptor: boolean;
};

export type Finding = {
  id?: number | string;
  session_id?: string;
  duplicate_of_id?: number | string | null;
  title: string;
  description: string;
  root_cause: string;
  severity: Severity;
  file_path: string;
  impact: string;
  trigger_conditions?: string | null;
  triggered_actor?: string | null;
  economic_impact?: string | null;
  confirmation_reason?: string | null;
  rejection_reason?: string | null;
  recommendation?: string | null;
  note?: string | null;
  human_status?: HumanFindingStatus | null;
  source_locations?: FindingSourceLocation[];
};

export type SessionDuplicateFindingGroup = {
  canonicalFinding?: Finding;
  duplicateFindings: Finding[];
  duplicateOfId: number | string;
};

export type HumanFindingReview = {
  action: HumanFindingReviewAction;
  findingKey: string;
  reviewedAt: string;
};

export type SessionFindingState = {
  findingId: number | string;
  findingKey: string;
  humanStatus: HumanFindingStatus | null;
  note: string | null;
  review: HumanFindingReview | null;
  sessionId: string;
};

export type LogEntry = {
  agent_message?: unknown;
  agentId?: string;
  level?: number;
  time?: string;
  source?: "program" | "ai" | "user" | string;
  msg?: string;
  stageIndex?: number;
  turnIndex?: number;
  workflowNodeId?: string;
  text?: string;
  message?: AgentMessage;
  turnStatus?: AgentTurnStatus;
  event?: string;
  payload?: unknown;
  stream?: "agent" | "program";
  workflowId?: string;
  [key: string]: unknown;
};

export type RunSummary = {
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
};

export type SessionDetails = {
  state: AuditSessionSnapshot;
  duplicateFindings: Finding[];
  duplicateGroups: SessionDuplicateFindingGroup[];
  findings: Finding[];
  localConfirmedFindings: Finding[];
  onchainConfirmedFindings: Finding[];
  pendingFindings: Finding[];
  humanFindingReviews: Record<string, HumanFindingReview>;
  logs: LogEntry[];
  logOffset: number;
  summary: RunSummary | null;
  totalLogCount: number;
};

export type SessionLogLimit = number | "all";
export type SessionDetailsOptions = {
  logLimit?: SessionLogLimit;
  logStream?: "agent" | "program";
};

export type SessionListOptions = {
  page?: number;
  pageSize?: number;
};

export type DeleteSessionResult = {
  deleted: true;
  sessionId: string;
};

export async function listSessionPage({
  page,
  pageSize,
}: SessionListOptions = {}): Promise<PaginatedList<AuditSessionSnapshot>> {
  const dbTotalCount = await countSessionStatesInDb();
  const { offset, ...pagination } = normalizePagination({
    page,
    pageSize,
    totalCount: dbTotalCount,
  });

  return {
    ...pagination,
    items: await listSessionStatesFromDb({
      skip: offset,
      take: pagination.pageSize,
    }),
  };
}

export async function dequeueSession(sessionId: string) {
  assertSafeDataId(sessionId, "Session ID");
  const result = await dequeueSessionInDb(sessionId);

  if (result.outcome === "not-found") {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (result.outcome === "queue-item-claimed") {
    throw new Error(
      `Session has already been claimed by a Queue Worker and cannot be dequeued: ${sessionId}`,
    );
  }
  if (result.outcome === "not-queued") {
    throw new Error(
      `Session is currently ${result.status} and cannot be dequeued: ${sessionId}`,
    );
  }

  return {
    message:
      result.outcome === "already-waiting"
        ? "Session is already waiting"
        : "Session was dequeued and is now waiting",
    removedQueueItems: result.removedQueueItems,
    sessionId,
    status: "wait" as const,
  };
}

export async function refreshSessionWorkflowSnapshot(sessionId: string) {
  assertSafeDataId(sessionId, "Session ID");

  const state = await readSessionStateFromDb(sessionId);
  if (!state) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (state.status === "running") {
    throw new Error(
      `Session is running and its Workflow snapshot cannot be updated: ${sessionId}`,
    );
  }

  const workflow = await getWorkflowDefinition(state.workflowId);
  const updated = await updateSessionWorkflowSnapshotInDb({
    sessionId,
    workflow,
  });
  if (!updated) {
    throw new Error(
      `Session is running and its Workflow snapshot cannot be updated: ${sessionId}`,
    );
  }

  return {
    message:
      "Session snapshot was replaced with the latest Workflow definition",
    sessionId,
    workflow: workflow.toJSON(),
    workflowId: workflow.id,
  };
}

export async function getSessionDetails(
  sessionId: string,
  projectRoot = process.cwd(),
  options: SessionDetailsOptions = {},
): Promise<SessionDetails | null> {
  const state = await readSessionStateFromDb(sessionId);

  if (!state) {
    return null;
  }

  const sessionDir = path.join(sessionsRoot(projectRoot), sessionId);
  const selectedLogFile =
    options.logStream === "program" ? "program.log" : "agent.log";
  const [
    rawConfirmedDbFindings,
    rawLocalConfirmedDbFindings,
    rawOnchainConfirmedDbFindings,
    rawDuplicateDbFindings,
    rawPendingDbFindings,
    humanFindingReviewLines,
    logSnapshot,
    programSummary,
    agentSummary,
  ] = await Promise.all([
    listCanonicalSessionFindingsFromDb({ sessionId }),
    listSessionFindingsFromDb({
      status: SessionFindingStatus.CONFIRMED,
      sessionId,
    }),
    listSessionFindingsFromDb({
      status: SessionFindingStatus.ONCHAIN_CONFIRMED,
      sessionId,
    }),
    listSessionFindingsFromDb({
      status: SessionFindingStatus.DUPLICATE,
      sessionId,
    }),
    listSessionFindingsFromDb({
      status: SessionFindingStatus.PENDING,
      sessionId,
    }),
    listSessionFindingReviewsFromDb(sessionId),
    readJsonLinesWithOffset<LogEntry>(path.join(sessionDir, selectedLogFile), {
      limit: options.logLimit ?? "all",
    }),
    readJsonLinesWithOffset<LogEntry>(path.join(sessionDir, "program.log"), {
      limit: "all",
    }),
    readJsonLinesWithOffset<LogEntry>(path.join(sessionDir, "agent.log"), {
      limit: "all",
    }),
  ]);

  const humanFindingReviews = latestHumanFindingReviews(
    humanFindingReviewLines,
  );
  const confirmedDbFindings = findingsWithLegacyHumanStatus(
    rawConfirmedDbFindings,
    "confirmed",
    humanFindingReviews,
  );
  const localConfirmedIds = new Set(
    rawLocalConfirmedDbFindings.map(({ id }) => String(id)),
  );
  const onchainConfirmedIds = new Set(
    rawOnchainConfirmedDbFindings.map(({ id }) => String(id)),
  );
  const localConfirmedDbFindings = confirmedDbFindings.filter(({ id }) =>
    localConfirmedIds.has(String(id)),
  );
  const onchainConfirmedDbFindings = confirmedDbFindings.filter(({ id }) =>
    onchainConfirmedIds.has(String(id)),
  );
  const pendingDbFindings = findingsWithLegacyHumanStatus(
    rawPendingDbFindings,
    "pending",
    humanFindingReviews,
  );
  const duplicateDbFindings = rawDuplicateDbFindings;

  return {
    state,
    duplicateFindings: duplicateDbFindings,
    duplicateGroups: sessionDuplicateFindingGroups(
      [...confirmedDbFindings, ...pendingDbFindings, ...duplicateDbFindings],
      duplicateDbFindings,
    ),
    findings: confirmedDbFindings,
    humanFindingReviews,
    localConfirmedFindings: localConfirmedDbFindings,
    onchainConfirmedFindings: onchainConfirmedDbFindings,
    pendingFindings: pendingDbFindings,
    logs: logSnapshot.items,
    logOffset: logSnapshot.offset,
    summary: extractRunSummary(
      [...programSummary.items, ...agentSummary.items],
      state.agents,
    ),
    totalLogCount: logSnapshot.totalCount,
  };
}

function sessionDuplicateFindingGroups(
  findings: Finding[],
  duplicateFindings: Finding[],
): SessionDuplicateFindingGroup[] {
  const findingById = new Map(
    findings
      .filter(
        (finding): finding is Finding & { id: number | string } =>
          typeof finding.id === "number" ||
          (typeof finding.id === "string" && finding.id.length > 0),
      )
      .map((finding) => [String(finding.id), finding]),
  );
  const groups = new Map<string, SessionDuplicateFindingGroup>();

  for (const duplicateFinding of duplicateFindings) {
    const duplicateOfId = duplicateFinding.duplicate_of_id;
    if (!duplicateOfId) {
      continue;
    }
    const duplicateOfKey = String(duplicateOfId);

    const group = groups.get(duplicateOfKey) ?? {
      canonicalFinding: findingById.get(duplicateOfKey),
      duplicateFindings: [],
      duplicateOfId,
    };
    group.duplicateFindings.push(duplicateFinding);
    groups.set(duplicateOfKey, group);
  }

  return [...groups.values()].sort((left, right) =>
    String(left.duplicateOfId).localeCompare(
      String(right.duplicateOfId),
      undefined,
      {
        numeric: true,
      },
    ),
  );
}

export async function listSessionArtifactTree({
  projectRoot = process.cwd(),
  sessionId,
  treePath = "",
}: SessionArtifactTreeOptions): Promise<SessionArtifactTreeEntry[]> {
  const artifactsRoot = await getSessionArtifactsRoot(projectRoot, sessionId);
  const relativeTreePath = normalizeSessionArtifactRelativePath(treePath, {
    allowEmpty: true,
  });
  const directoryPath = resolveSessionArtifactChildPath(
    artifactsRoot,
    relativeTreePath,
  );
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(
      `Session artifact path is not a directory: ${relativeTreePath}`,
    );
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const treeEntries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map(async (entry) => {
        const entryPath = relativeTreePath
          ? `${relativeTreePath}/${entry.name}`
          : entry.name;
        const absoluteEntryPath = path.join(
          /*turbopackIgnore: true*/ directoryPath,
          entry.name,
        );
        const entryStat = await stat(
          /*turbopackIgnore: true*/ absoluteEntryPath,
        );
        return {
          name: entry.name,
          path: entryPath,
          size: entry.isFile() ? entryStat.size : undefined,
          type: entry.isDirectory() ? "dir" : "file",
        } satisfies SessionArtifactTreeEntry;
      }),
  );

  return treeEntries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "dir" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export async function createSessionArtifactArchive({
  projectRoot = process.cwd(),
  sessionId,
  treePath = "",
}: SessionArtifactArchiveOptions): Promise<SessionArtifactArchive> {
  const artifactsRoot = await getSessionArtifactsRoot(projectRoot, sessionId);
  const relativeTreePath = normalizeSessionArtifactRelativePath(treePath, {
    allowEmpty: true,
  });
  if (sessionArtifactArchivePathContainsExcludedSegment(relativeTreePath)) {
    throw new Error(
      `Session artifact path cannot be archived: ${relativeTreePath}`,
    );
  }
  const directoryPath = resolveSessionArtifactChildPath(
    artifactsRoot,
    relativeTreePath,
  );
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(
      `Session artifact path is not a directory: ${relativeTreePath}`,
    );
  }

  const archiveRootName = sessionArtifactArchiveRootName(relativeTreePath);
  const entries = await listSessionArtifactArchiveEntries(
    directoryPath,
    archiveRootName,
  );
  if (entries.length > ZIP_MAX_UINT16) {
    throw new Error(
      `Session artifact directory contains too many files to archive as ZIP: ${relativeTreePath || "."}`,
    );
  }

  const nodeStream = Readable.from(streamStoredZipArchive(entries));
  return {
    fileName: `${sessionId}-${sessionArtifactArchiveFileNamePart(archiveRootName)}.zip`,
    mimeType: "application/zip",
    stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
  };
}

export async function createSessionArtifactFileDownload({
  filePath,
  projectRoot = process.cwd(),
  sessionId,
}: SessionArtifactFileOptions): Promise<SessionArtifactFileDownload> {
  const artifactsRoot = await getSessionArtifactsRoot(projectRoot, sessionId);
  const relativeFilePath = normalizeSessionArtifactRelativePath(filePath, {
    allowEmpty: false,
  });
  const absoluteFilePath = resolveSessionArtifactChildPath(
    artifactsRoot,
    relativeFilePath,
  );
  const fileStat = await stat(absoluteFilePath);
  if (!fileStat.isFile()) {
    throw new Error(`Session artifact path is not a file: ${relativeFilePath}`);
  }

  const nodeStream = createReadStream(absoluteFilePath);
  return {
    fileName: path.basename(relativeFilePath),
    mimeType: "application/octet-stream",
    stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
  };
}

export async function readSessionArtifactFile({
  filePath,
  projectRoot = process.cwd(),
  sessionId,
}: SessionArtifactFileOptions): Promise<SessionArtifactFileContent> {
  const artifactsRoot = await getSessionArtifactsRoot(projectRoot, sessionId);
  const relativeFilePath = normalizeSessionArtifactRelativePath(filePath, {
    allowEmpty: false,
  });
  const absoluteFilePath = resolveSessionArtifactChildPath(
    artifactsRoot,
    relativeFilePath,
  );
  const fileStat = await stat(absoluteFilePath);
  if (!fileStat.isFile()) {
    throw new Error(`Session artifact path is not a file: ${relativeFilePath}`);
  }

  if (fileStat.size === 0) {
    return {
      content: "",
      encoding: "utf-8",
      maxBytes: SESSION_ARTIFACT_FILE_PREVIEW_MAX_BYTES,
      name: path.basename(relativeFilePath),
      path: relativeFilePath,
      size: fileStat.size,
      truncated: false,
    };
  }

  const readLength = Math.min(
    fileStat.size,
    SESSION_ARTIFACT_FILE_PREVIEW_MAX_BYTES + 1,
  );
  const fileHandle = await open(absoluteFilePath, "r");
  try {
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await fileHandle.read(buffer, 0, readLength, 0);
    const readBuffer = buffer.subarray(0, bytesRead);

    if (isLikelyBinarySessionArtifactFile(readBuffer)) {
      throw new Error(
        `Session artifact is not a previewable text file: ${relativeFilePath}`,
      );
    }

    const contentBuffer = readBuffer.subarray(
      0,
      SESSION_ARTIFACT_FILE_PREVIEW_MAX_BYTES,
    );
    return {
      content: contentBuffer.toString("utf8"),
      encoding: "utf-8",
      maxBytes: SESSION_ARTIFACT_FILE_PREVIEW_MAX_BYTES,
      name: path.basename(relativeFilePath),
      path: relativeFilePath,
      size: fileStat.size,
      truncated:
        bytesRead > SESSION_ARTIFACT_FILE_PREVIEW_MAX_BYTES ||
        fileStat.size > SESSION_ARTIFACT_FILE_PREVIEW_MAX_BYTES,
    };
  } finally {
    await fileHandle.close();
  }
}

export async function deleteSession({
  projectRoot = process.cwd(),
  sessionId,
}: {
  projectRoot?: string;
  sessionId: string;
}): Promise<DeleteSessionResult> {
  assertSafeDataId(sessionId, "Session ID");

  const state = await readSessionStateFromDb(sessionId);
  if (!state) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (isSessionActive(state)) {
    throw new Error(`Session is running and cannot be deleted: ${sessionId}`);
  }

  await getSessionQueue().removeSession(sessionId);
  await rm(path.join(sessionsRoot(projectRoot), sessionId), {
    force: true,
    recursive: true,
  });
  await deleteSessionStateFromDb(sessionId);

  return {
    deleted: true,
    sessionId,
  };
}

export async function reviewSessionFinding({
  action,
  findingId,
  projectRoot = process.cwd(),
  sessionId,
}: {
  action: HumanFindingReviewAction;
  findingId: number | string;
  projectRoot?: string;
  sessionId: string;
}) {
  assertHumanFindingReviewAction(action);

  const details = await getSessionDetails(sessionId, projectRoot);

  if (!details) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const reviewableFinding = findReviewableFinding(details, findingId);

  if (!reviewableFinding) {
    throw new Error(
      "Only pending or Agent-confirmed findings in the current Session can be manually confirmed.",
    );
  }

  const review: HumanFindingReview = {
    action,
    findingKey: reviewableFinding.findingKey,
    reviewedAt: new Date().toISOString(),
  };

  const humanStatus = humanStatusForReviewAction(action);
  const finding = await updateSessionFindingHumanStatusInDb({
    findingId: reviewableFinding.finding.id!,
    humanStatus,
    sessionId,
  });
  if (!finding) {
    throw new Error(`Finding not found: ${reviewableFinding.finding.id}`);
  }

  await appendSessionFindingReviewToDb({ review, sessionId });

  return {
    finding,
    findingKey: reviewableFinding.findingKey,
    review,
    source: reviewableFinding.source,
  };
}

export async function applySessionFindingReviews({
  decisionsByFindingKey,
  overwriteExisting = true,
  projectRoot = process.cwd(),
  sessionId,
}: {
  decisionsByFindingKey: Record<string, SessionFindingReviewDecision>;
  overwriteExisting?: boolean;
  projectRoot?: string;
  sessionId: string;
}) {
  const details = await getSessionDetails(sessionId, projectRoot);

  if (!details) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const reviewedAt = new Date().toISOString();
  let appliedCount = 0;

  for (const [index, finding] of details.findings.entries()) {
    if (!finding.id || (!overwriteExisting && finding.human_status)) {
      continue;
    }

    const findingKey = findingKeyFor("confirmed", index, finding);
    const action = decisionsByFindingKey[findingKey];
    if (!action) {
      continue;
    }

    const updatedFinding = await updateSessionFindingHumanStatusInDb({
      findingId: finding.id,
      humanStatus: humanStatusForReviewAction(action),
      sessionId,
    });
    if (!updatedFinding) {
      throw new Error(`Finding not found: ${finding.id}`);
    }

    await appendSessionFindingReviewToDb({
      review: { action, findingKey, reviewedAt },
      sessionId,
    });
    appliedCount += 1;
  }

  return { appliedCount, sessionId };
}

export async function updateSessionFindingNote({
  findingId,
  note,
  sessionId,
}: {
  findingId: number | string;
  note: string;
  sessionId: string;
}) {
  const parsed = findingNoteUpdateSchema.parse({ findingId, note });
  const finding = await updateSessionFindingNoteInDb({
    findingId: parsed.findingId,
    note: parsed.note || null,
    sessionId,
  });

  if (!finding) {
    throw new Error(`Finding not found: ${parsed.findingId}`);
  }

  return finding;
}

export async function getSessionFindingState({
  findingId,
  findingKey,
  sessionId,
}: {
  findingId: number | string;
  findingKey: string;
  sessionId: string;
}): Promise<SessionFindingState> {
  const findings = await Promise.all(
    [
      SessionFindingStatus.CONFIRMED,
      SessionFindingStatus.ONCHAIN_CONFIRMED,
      SessionFindingStatus.PENDING,
      SessionFindingStatus.DUPLICATE,
      SessionFindingStatus.REJECTED,
    ].map((status) => listSessionFindingsFromDb({ sessionId, status })),
  );
  const finding = findings
    .flat()
    .find((candidate) => String(candidate.id) === String(findingId));

  if (!finding?.id) {
    throw new Error(`Finding not found: ${findingId}`);
  }

  let review: HumanFindingReview | null = null;
  for (const candidate of await listSessionFindingReviewsFromDb(sessionId)) {
    if (candidate.findingKey !== findingKey) continue;
    review = candidate.action === "reset" ? null : candidate;
  }

  return {
    findingId: finding.id,
    findingKey,
    humanStatus:
      finding.human_status ??
      humanStatusForReviewAction(review?.action ?? "reset"),
    note: finding.note ?? null,
    review,
    sessionId,
  };
}

function humanStatusForReviewAction(
  action: HumanFindingReviewAction,
): HumanFindingStatus | null {
  if (action === "confirm") return HumanFindingStatus.TP;
  if (action === "pass") return HumanFindingStatus.FP;
  return null;
}

function findingsWithLegacyHumanStatus(
  findings: Finding[],
  source: FindingSource,
  reviews: Record<string, HumanFindingReview>,
) {
  return findings.map((finding, index) => {
    if (finding.human_status) return finding;
    const review = reviews[findingKeyFor(source, index, finding)];
    const humanStatus = review
      ? humanStatusForReviewAction(review.action)
      : null;
    return humanStatus ? { ...finding, human_status: humanStatus } : finding;
  });
}

function findReviewableFinding(
  details: SessionDetails,
  findingId: number | string,
) {
  for (const [index, finding] of details.findings.entries()) {
    if (String(finding.id) === String(findingId)) {
      return {
        finding,
        findingKey: findingKeyFor("confirmed", index, finding),
        source: "confirmed" as const,
      };
    }
  }

  for (const [index, finding] of details.pendingFindings.entries()) {
    if (String(finding.id) === String(findingId)) {
      return {
        finding,
        findingKey: findingKeyFor("pending", index, finding),
        source: "pending" as const,
      };
    }
  }

  return null;
}

export function findingKeyFor(
  source: FindingSource,
  index: number,
  finding: Finding,
) {
  const identity = finding.id
    ? {
        id: finding.id,
        source,
      }
    : {
        description: finding.description,
        file_path: finding.file_path,
        index,
        severity: finding.severity,
        source,
        title: finding.title,
      };

  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 24);
}

function latestHumanFindingReviews(reviews: HumanFindingReview[]) {
  const latest: Record<string, HumanFindingReview> = {};

  for (const review of reviews) {
    if (!isHumanFindingReview(review)) {
      continue;
    }

    if (review.action === "reset") {
      delete latest[review.findingKey];
      continue;
    }

    latest[review.findingKey] = review;
  }

  return latest;
}

function assertHumanFindingReviewAction(
  action: string,
): asserts action is HumanFindingReviewAction {
  if (action !== "confirm" && action !== "pass" && action !== "reset") {
    throw new Error(`Invalid manual review action: ${action}`);
  }
}

function isHumanFindingReview(value: unknown): value is HumanFindingReview {
  const review = recordValue(value);

  if (!review) {
    return false;
  }

  return (
    typeof review.findingKey === "string" &&
    typeof review.reviewedAt === "string" &&
    (review.action === "confirm" ||
      review.action === "pass" ||
      review.action === "reset")
  );
}

function isSessionActive(state: AuditSessionSnapshot) {
  return state.status === "queued" || state.status === "running";
}

async function listSessionArtifactArchiveEntries(
  directoryPath: string,
  archiveRootName: string,
) {
  const entries: ZipArchiveItem[] = [];

  await appendZipDirectory(entries, directoryPath, `${archiveRootName}/`);
  return entries;
}

async function appendZipDirectory(
  entries: ZipArchiveItem[],
  directoryPath: string,
  archivePath: string,
) {
  const directoryStat = await stat(directoryPath);
  entries.push({
    archivePath,
    directory: true,
    mtime: directoryStat.mtime,
  });

  const children = await readdir(directoryPath, { withFileTypes: true });
  const sortedChildren = children
    .filter(
      (entry) =>
        (entry.isDirectory() || entry.isFile()) &&
        !isSessionArtifactArchiveExcludedName(entry.name),
    )
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  for (const child of sortedChildren) {
    const childPath = path.join(directoryPath, child.name);
    const childArchivePath = `${archivePath}${zipArchivePathSegment(child.name)}`;

    if (child.isDirectory()) {
      await appendZipDirectory(entries, childPath, `${childArchivePath}/`);
      continue;
    }

    const childStat = await stat(childPath);
    if (childStat.size > ZIP_MAX_UINT32) {
      throw new Error(
        `Session artifact is too large to archive as ZIP: ${childArchivePath}`,
      );
    }

    entries.push({
      absolutePath: childPath,
      archivePath: childArchivePath,
      directory: false,
      mtime: childStat.mtime,
    });
  }
}

async function* streamStoredZipArchive(entries: ZipArchiveItem[]) {
  const centralRecords: ZipCentralRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    const localHeaderOffset = offset;
    const usesDataDescriptor = !entry.directory;
    const localHeader = createZipLocalHeader(entry, {
      compressedSize: 0,
      crc32: 0,
      uncompressedSize: 0,
      usesDataDescriptor,
    });

    yield localHeader;
    offset += localHeader.length;

    if (entry.directory) {
      centralRecords.push({
        ...entry,
        compressedSize: 0,
        crc32: 0,
        localHeaderOffset,
        uncompressedSize: 0,
        usesDataDescriptor,
      });
      continue;
    }

    if (!entry.absolutePath) {
      throw new Error(
        `Session artifact ZIP entry is missing a file path: ${entry.archivePath}`,
      );
    }

    let crc = 0xffffffff;
    let size = 0;
    for await (const chunk of createReadStream(entry.absolutePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = updateCrc32(crc, buffer);
      size += buffer.length;
      if (size > ZIP_MAX_UINT32) {
        throw new Error(
          `Session artifact is too large to archive as ZIP: ${entry.archivePath}`,
        );
      }
      yield buffer;
      offset += buffer.length;
    }

    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    const dataDescriptor = createZipDataDescriptor(finalCrc, size);
    yield dataDescriptor;
    offset += dataDescriptor.length;

    centralRecords.push({
      ...entry,
      compressedSize: size,
      crc32: finalCrc,
      localHeaderOffset,
      uncompressedSize: size,
      usesDataDescriptor,
    });
  }

  const centralDirectoryOffset = offset;
  for (const record of centralRecords) {
    if (record.localHeaderOffset > ZIP_MAX_UINT32) {
      throw new Error(
        "Session artifact ZIP exceeds 4 GiB and cannot be generated.",
      );
    }

    const centralHeader = createZipCentralHeader(record);
    yield centralHeader;
    offset += centralHeader.length;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  if (
    centralDirectoryOffset > ZIP_MAX_UINT32 ||
    centralDirectorySize > ZIP_MAX_UINT32
  ) {
    throw new Error(
      "Session artifact ZIP exceeds 4 GiB and cannot be generated.",
    );
  }

  yield createZipEndRecord({
    centralDirectoryOffset,
    centralDirectorySize,
    entryCount: centralRecords.length,
  });
}

function createZipLocalHeader(
  entry: ZipArchiveItem,
  values: {
    compressedSize: number;
    crc32: number;
    uncompressedSize: number;
    usesDataDescriptor: boolean;
  },
) {
  const name = Buffer.from(entry.archivePath, "utf8");
  const { dosDate, dosTime } = zipDosDateTime(entry.mtime);
  const header = Buffer.alloc(30);

  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
  header.writeUInt16LE(zipFlags(values.usesDataDescriptor), 6);
  header.writeUInt16LE(ZIP_STORE_METHOD, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(values.crc32, 14);
  header.writeUInt32LE(values.compressedSize, 18);
  header.writeUInt32LE(values.uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);

  return Buffer.concat([header, name]);
}

function createZipCentralHeader(record: ZipCentralRecord) {
  const name = Buffer.from(record.archivePath, "utf8");
  const { dosDate, dosTime } = zipDosDateTime(record.mtime);
  const header = Buffer.alloc(46);

  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(ZIP_VERSION_MADE_BY_UNIX, 4);
  header.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
  header.writeUInt16LE(zipFlags(record.usesDataDescriptor), 8);
  header.writeUInt16LE(ZIP_STORE_METHOD, 10);
  header.writeUInt16LE(dosTime, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(record.crc32, 16);
  header.writeUInt32LE(record.compressedSize, 20);
  header.writeUInt32LE(record.uncompressedSize, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(zipExternalAttributes(record), 38);
  header.writeUInt32LE(record.localHeaderOffset, 42);

  return Buffer.concat([header, name]);
}

function createZipDataDescriptor(crc32: number, size: number) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc32, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function createZipEndRecord({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
}: {
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entryCount: number;
}) {
  const endRecord = Buffer.alloc(22);

  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entryCount, 8);
  endRecord.writeUInt16LE(entryCount, 10);
  endRecord.writeUInt32LE(centralDirectorySize, 12);
  endRecord.writeUInt32LE(centralDirectoryOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return endRecord;
}

function zipFlags(usesDataDescriptor: boolean) {
  return ZIP_UTF8_FLAG | (usesDataDescriptor ? ZIP_DATA_DESCRIPTOR_FLAG : 0);
}

function zipExternalAttributes(entry: ZipArchiveItem) {
  const unixMode = entry.directory ? 0o40755 : 0o100644;
  return (unixMode << 16) >>> 0;
}

function zipDosDateTime(date: Date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getFullYear() < 1980 ? 1 : date.getMonth() + 1;
  const day = date.getFullYear() < 1980 ? 1 : date.getDate();
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;

  return { dosDate, dosTime };
}

function updateCrc32(crc: number, buffer: Uint8Array) {
  let nextCrc = crc;

  for (const byte of buffer) {
    nextCrc = (nextCrc >>> 8) ^ CRC32_TABLE[(nextCrc ^ byte) & 0xff];
  }

  return nextCrc >>> 0;
}

const CRC32_TABLE = createCrc32Table();

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }

  return table;
}

function sessionArtifactArchiveRootName(relativeTreePath: string) {
  if (!relativeTreePath) {
    return "artifacts";
  }

  const name = relativeTreePath.split("/").filter(Boolean).pop();
  return name ? zipArchivePathSegment(name) : "artifacts";
}

function sessionArtifactArchiveFileNamePart(archiveRootName: string) {
  const safeName = archiveRootName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return safeName || "artifacts";
}

function sessionArtifactArchivePathContainsExcludedSegment(
  relativePath: string,
) {
  return relativePath
    .split("/")
    .filter(Boolean)
    .some(isSessionArtifactArchiveExcludedName);
}

function isSessionArtifactArchiveExcludedName(name: string) {
  return SESSION_ARTIFACT_ARCHIVE_EXCLUDED_NAMES.has(name);
}

function zipArchivePathSegment(value: string) {
  return value.replace(/\\/g, "_");
}

async function getSessionArtifactsRoot(projectRoot: string, sessionId: string) {
  assertSafeDataId(sessionId, "sessionId");
  const state = await readSessionStateFromDb(sessionId);
  if (!state) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const artifactsRoot = path.join(sessionsRoot(projectRoot), sessionId);
  const artifactsStat = await stat(artifactsRoot).catch(() => null);
  if (!artifactsStat?.isDirectory()) {
    throw new Error(`Session artifacts not found: ${sessionId}`);
  }

  return artifactsRoot;
}

function normalizeSessionArtifactRelativePath(
  value: string,
  { allowEmpty }: { allowEmpty: boolean },
) {
  const normalizedSeparators = value.trim().replace(/\\/g, "/");
  if (!normalizedSeparators) {
    if (allowEmpty) {
      return "";
    }
    throw new Error("Session artifact path cannot be empty.");
  }

  if (
    normalizedSeparators.includes("\0") ||
    path.posix.isAbsolute(normalizedSeparators)
  ) {
    throw new Error(`Invalid Session artifact path: ${value}`);
  }

  const segments = normalizedSeparators.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid Session artifact path: ${value}`);
  }

  return segments.join("/");
}

function resolveSessionArtifactChildPath(
  artifactsRoot: string,
  relativePath: string,
) {
  const absoluteArtifactsRoot = path.resolve(
    /*turbopackIgnore: true*/ artifactsRoot,
  );
  const resolvedPath = path.resolve(
    /*turbopackIgnore: true*/ absoluteArtifactsRoot,
    relativePath,
  );
  const relativeResolvedPath = path.relative(
    absoluteArtifactsRoot,
    resolvedPath,
  );

  if (
    relativeResolvedPath.startsWith("..") ||
    path.isAbsolute(relativeResolvedPath)
  ) {
    throw new Error(`Session artifact path escapes its root: ${relativePath}`);
  }

  return resolvedPath;
}

function isLikelyBinarySessionArtifactFile(buffer: Buffer) {
  const sample = buffer.subarray(0, SESSION_ARTIFACT_FILE_BINARY_SAMPLE_BYTES);
  return sample.includes(0);
}

function assertSafeDataId(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function sessionsRoot(projectRoot = process.cwd()) {
  return path.join(projectRoot, ".data", "session");
}

async function readJsonLinesWithOffset<T>(
  filePath: string,
  {
    limit = "all",
  }: {
    limit?: SessionLogLimit;
  } = {},
) {
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return {
      items: [] as T[],
      offset: 0,
      summaryItems: [] as T[],
      totalCount: 0,
    };
  }

  if (limit === "all") {
    const content = await readFile(filePath, "utf8");
    const items = parseJsonLines<T>(content);

    return {
      items,
      offset: Buffer.byteLength(content, "utf8"),
      summaryItems: items,
      totalCount: items.length,
    };
  }

  const snapshot = await readLimitedJsonLinesWithCount<T>(filePath, limit);
  const summaryItems =
    snapshot.totalCount <= snapshot.items.length
      ? snapshot.items
      : await readTailJsonLines<T>(filePath, SESSION_LOG_SUMMARY_TAIL_BYTES);

  return {
    ...snapshot,
    summaryItems,
  };
}

async function readLimitedJsonLinesWithCount<T>(
  filePath: string,
  limit: number,
) {
  const fileStat = await stat(filePath);
  const items: T[] = [];
  let buffered = "";
  let totalCount = 0;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    totalCount += 1;
    if (items.length >= limit) {
      return;
    }

    const parsed = parseJsonLine<T>(trimmed);
    if (parsed !== undefined) {
      items.push(parsed);
    }
  };

  for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      handleLine(line);
    }
  }

  handleLine(buffered);

  return {
    items,
    offset: fileStat.size,
    totalCount,
  };
}

async function readTailJsonLines<T>(filePath: string, maxBytes: number) {
  const fileStat = await stat(filePath);
  if (fileStat.size <= 0) {
    return [] as T[];
  }

  const length = Math.min(fileStat.size, maxBytes);
  const start = fileStat.size - length;
  const file = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);
    let content = buffer.toString("utf8");

    if (start > 0) {
      const firstNewline = content.indexOf("\n");
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    }

    return parseJsonLines<T>(content);
  } finally {
    await file.close();
  }
}

function parseJsonLines<T>(content: string) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = parseJsonLine<T>(line);
      return parsed === undefined ? [] : [parsed];
    });
}

function parseJsonLine<T>(line: string) {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

type SessionUsageParser = {
  agentId: string;
  parser: BaseUsage;
};

export function extractRunSummary(
  logs: LogEntry[],
  agentIds: readonly string[],
): RunSummary | null {
  const registeredAgentIds = new Set(
    listAgentDefinitions().map(({ id }) => id),
  );
  if (agentIds.some((agentId) => !registeredAgentIds.has(agentId.trim()))) {
    return null;
  }

  return extractAgentRunSummary(
    logs,
    agentIds.map((agentId) => ({
      agentId,
      parser: createUsageParser(agentId),
    })),
  );
}

function extractAgentRunSummary(
  logs: LogEntry[],
  parsers: readonly SessionUsageParser[],
): RunSummary | null {
  const summary: RunSummary = {};
  const snapshots = new Map<string, UsageObservation>();
  let hasUsage = false;

  for (const log of logs) {
    const parser = parserForLog(log, parsers);
    if (!parser) continue;
    for (const usage of parser.parser.parse(log.agent_message ?? log)) {
      hasUsage = true;
      if (usage.aggregation === "snapshot") {
        if (!usage.scopeId) continue;
        snapshots.set(snapshotKey(parser.agentId, usage), usage);
      } else {
        addUsage(summary, usage);
      }
    }
  }
  for (const usage of snapshots.values()) {
    addUsage(summary, usage);
  }

  return hasUsage ? summary : null;
}

function parserForLog(log: LogEntry, parsers: readonly SessionUsageParser[]) {
  if (log.agentId) {
    const parser = parsers.find((item) => item.agentId === log.agentId);
    if (parser) return parser;
  }
  if (typeof log.stageIndex === "number") {
    return parsers[log.stageIndex];
  }
  return parsers.length === 1 ? parsers[0] : undefined;
}

function snapshotKey(agentId: string | undefined, usage: UsageObservation) {
  return [agentId ?? "unknown", usage.scopeId, usage.model ?? "default"].join(
    "\u0000",
  );
}

function addUsage(summary: RunSummary, usage: UsageObservation) {
  addUsageValue(summary, "cacheReadInputTokens", usage.cacheReadInputTokens);
  addUsageValue(summary, "cacheWriteInputTokens", usage.cacheWriteInputTokens);
  addUsageValue(summary, "inputTokens", usage.inputTokens);
  addUsageValue(summary, "outputTokens", usage.outputTokens);
  addUsageValue(summary, "reasoningOutputTokens", usage.reasoningOutputTokens);
  addUsageValue(summary, "totalCostUsd", usage.totalCostUsd);
}

function addUsageValue<K extends keyof RunSummary>(
  summary: RunSummary,
  key: K,
  value: number | undefined,
) {
  if (value === undefined) return;
  summary[key] = ((summary[key] ?? 0) + value) as RunSummary[K];
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
