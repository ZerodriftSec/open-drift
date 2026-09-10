import { createAgent } from "@/audit/agent/registry";
import { modelProviderQueueKey } from "@/audit/queue/model-provider-key";
import { AuditSession } from "@/audit/session";
import type { WorkflowDefinition } from "@/audit/workflow";
import { AuditStatus } from "@/audit/session/types";
import {
  getWorkflowDefinition,
  type ResolvedWorkflowDefinition,
} from "@/server/workflows";
import {
  mergeTaskMetadata,
  taskSourceOrDefault,
  splitTaskMetadata,
  type TaskMetadata,
} from "@/lib/task-metadata";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Entry, ZipFile } from "yauzl";
import * as yauzl from "yauzl";
import {
  clearSessionFindingArtifactsFromDb,
  getSessionQueue,
  readUploadStateFromDb,
  upsertUploadStateToDb,
} from "../db/store";
import { ensureAppRuntimeCleanup } from "../runtime/cleanup";

const ZIP_HASH_LENGTH = 64;
const UPLOAD_RANDOM_ID_LENGTH = 12;

export type UploadArchive = {
  arrayBuffer: () => Promise<ArrayBuffer>;
  name: string;
};

export type UploadSessionResult = {
  workflowId: string;
  metadata?: TaskMetadata;
  projectName: string;
  sessionDir: string;
  sessionId: string;
  source?: string;
  uploadId: string;
};

export type PathSessionResult = {
  workflowId: string;
  backupDir?: string;
  metadata?: TaskMetadata;
  projectName: string;
  sessionDir: string;
  sessionId: string;
  source?: string;
  targetPath: string;
};

export type UploadState = {
  workflowId: string;
  metadata?: TaskMetadata;
  projectName?: string;
  source?: string;
  targetPath: string;
  uploadId: string;
};

export type UploadArchiveResult = UploadState & {
  archiveHash: string;
};

export type UploadTreeEntry = {
  name: string;
  path: string;
  size?: number;
  type: "dir" | "file";
};

export async function createUploadArchive({
  workflowId,
  archive,
  metadata,
  projectName,
  projectRoot,
}: {
  workflowId: string;
  archive: UploadArchive;
  metadata?: TaskMetadata;
  projectName?: string;
  projectRoot: string;
}): Promise<UploadArchiveResult> {
  await ensureAppRuntimeCleanup(projectRoot);

  return prepareUploadArchive({
    workflowId,
    archive,
    metadata,
    projectName,
    projectRoot,
  });
}

export async function createAndStartPathSession({
  agentIds,
  workflowId,
  metadata,
  projectName,
  projectRoot,
  run = true,
  sessionId,
  targetPath,
}: {
  agentIds: readonly string[];
  workflowId: string;
  metadata?: TaskMetadata;
  projectName?: string;
  projectRoot: string;
  run?: boolean;
  sessionId?: string;
  targetPath: string;
}): Promise<PathSessionResult> {
  await ensureAppRuntimeCleanup(projectRoot);

  const workflow = await getWorkflowDefinition(workflowId);
  assertWorkflowAgentIds(agentIds, workflow);
  const task = splitTaskMetadata(metadata);
  const resolvedTargetPath = await resolveLocalTargetPath(
    projectRoot,
    targetPath,
  );
  const session = await createPathSessionRecord({
    agentIds,
    workflow,
    initialStatus: run ? AuditStatus.QUEUED : AuditStatus.WAIT,
    metadata: task.metadata,
    projectName:
      normalizeProjectName(projectName) ??
      path.basename(resolvedTargetPath) ??
      undefined,
    sessionId,
    source: taskSourceOrDefault(task.source),
    targetPath: resolvedTargetPath,
  });

  if (run) {
    await getSessionQueue().enqueue({
      key: modelProviderQueueKey(agentIds),
      sessionId: session.sessionId,
    });
  }

  return pathSessionResult(session);
}

export async function rerunPathSessionInPlace({
  agentIds,
  workflow: sessionWorkflow,
  workflowId,
  metadata,
  originalCreatedAt,
  projectName,
  projectRoot,
  sessionId,
  targetPath,
}: {
  agentIds: readonly string[];
  workflow?: ResolvedWorkflowDefinition;
  workflowId: string;
  metadata?: TaskMetadata;
  originalCreatedAt: string;
  projectName?: string;
  projectRoot: string;
  sessionId: string;
  targetPath: string;
}): Promise<PathSessionResult & { backupDir?: string }> {
  await ensureAppRuntimeCleanup(projectRoot);
  assertSafeSessionId(sessionId);

  const workflow = sessionWorkflow ?? (await getWorkflowDefinition(workflowId));
  assertWorkflowAgentIds(agentIds, workflow);
  const task = splitTaskMetadata(metadata);
  const resolvedTargetPath = await resolveLocalTargetPath(
    projectRoot,
    targetPath,
  );

  await getSessionQueue().removeSession(sessionId);
  const backupDir = await backupAndClearSessionDirectory({
    projectRoot,
    sessionId,
  });
  await clearSessionFindingArtifactsFromDb(sessionId);

  // createPathSessionRecord upserts this row. Keeping it preserves FK-backed
  // SessionGroupMember records while the session is reset in place.

  const session = await createPathSessionRecord({
    agentIds,
    createdAt: originalCreatedAt,
    workflow,
    initialStatus: AuditStatus.QUEUED,
    metadata: task.metadata,
    projectName:
      normalizeProjectName(projectName) ??
      path.basename(resolvedTargetPath) ??
      undefined,
    sessionId,
    source: taskSourceOrDefault(task.source),
    targetPath: resolvedTargetPath,
  });

  await getSessionQueue().enqueue({
    key: modelProviderQueueKey(agentIds),
    sessionId: session.sessionId,
  });

  return pathSessionResult(session, backupDir);
}

export async function startUploadSessionFromUpload({
  agentIds,
  workflowId,
  excludedPaths,
  metadata,
  projectName,
  projectRoot,
  run = true,
  uploadId,
}: {
  agentIds: readonly string[];
  workflowId: string;
  excludedPaths?: string[];
  metadata?: TaskMetadata;
  projectName?: string;
  projectRoot: string;
  run?: boolean;
  uploadId: string;
}): Promise<UploadSessionResult> {
  await ensureAppRuntimeCleanup(projectRoot);

  const storedUpload = await readUploadState(uploadId);
  if (!storedUpload) {
    throw new Error(`Upload not found: ${uploadId}`);
  }
  if (storedUpload.workflowId !== workflowId) {
    throw new Error(
      "The upload is pinned to another Workflow and cannot be replaced at launch.",
    );
  }
  const workflow = await getWorkflowDefinition(storedUpload.workflowId);
  assertWorkflowAgentIds(agentIds, workflow);

  let scopedUpload = storedUpload;
  if (excludedPaths?.length) {
    scopedUpload = await removeExcludedUploadPaths({
      excludedPaths,
      upload: storedUpload,
    });
  }

  const task = splitTaskMetadata(
    mergeTaskMetadata(scopedUpload.metadata, metadata),
  );
  const upload: PreparedUpload = {
    ...scopedUpload,
    workflowId: workflow.id,
    metadata: task.metadata,
    projectName: normalizeProjectName(projectName) ?? scopedUpload.projectName,
    source: taskSourceOrDefault(task.source ?? scopedUpload.source),
  };

  return createPreparedUploadSession({
    agentIds,
    ...upload,
    run,
    workflow,
  });
}

export async function readUploadState(uploadId: string) {
  assertSafeUploadId(uploadId);
  return readUploadStateFromDb(uploadId);
}

export async function listUploadTree({
  treePath = "",
  uploadId,
}: {
  treePath?: string;
  uploadId: string;
}): Promise<UploadTreeEntry[]> {
  const upload = await readUploadState(uploadId);
  if (!upload) {
    throw new Error(`Upload not found: ${uploadId}`);
  }

  const relativeTreePath = normalizeUploadRelativePath(treePath, {
    allowEmpty: true,
  });
  const directoryPath = resolveUploadTargetChildPath(
    upload.targetPath,
    relativeTreePath,
  );
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Upload path is not a directory: ${relativeTreePath}`);
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
        } satisfies UploadTreeEntry;
      }),
  );

  return treeEntries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "dir" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

async function prepareUploadArchive({
  workflowId,
  archive,
  metadata,
  projectName,
  projectRoot,
}: {
  workflowId: string;
  archive: UploadArchive;
  metadata?: TaskMetadata;
  projectName?: string;
  projectRoot: string;
}) {
  let uploadDir: string | undefined;

  try {
    const workflow = await getWorkflowDefinition(workflowId);
    const task = splitTaskMetadata(metadata);
    assertZipArchive(archive);

    const uploadId = createUploadId();
    uploadDir = path.join(projectRoot, ".data", "upload", uploadId);
    const extractDir = path.join(uploadDir, "extract");

    await mkdir(extractDir, { recursive: true });

    const buffer = Buffer.from(await archive.arrayBuffer());
    assertZipMagic(buffer);

    const archiveHash = createHash("sha256")
      .update(buffer)
      .digest("hex")
      .slice(0, ZIP_HASH_LENGTH);
    const archivePath = path.join(uploadDir, `${archiveHash}.zip`);

    await writeFile(archivePath, buffer);
    await extractZip(archivePath, extractDir);
    await removeMacosMetadata(extractDir);
    const targetPath = await resolveUploadTargetPath(extractDir, archive.name);

    const upload: UploadState = {
      workflowId: workflow.id,
      metadata: task.metadata,
      projectName:
        normalizeProjectName(projectName) ??
        projectNameFromArchiveName(archive.name),
      source: taskSourceOrDefault(task.source),
      targetPath,
      uploadId,
    };

    await upsertUploadStateToDb(upload);

    return {
      ...upload,
      archiveHash,
    };
  } catch (error) {
    if (uploadDir) {
      await rm(uploadDir, { force: true, recursive: true });
    }

    throw error;
  }
}

type PreparedUpload = UploadState;

function assertWorkflowAgentIds(
  agentIds: readonly string[],
  workflow: WorkflowDefinition,
) {
  if (agentIds.length !== workflow.stages.length) {
    throw new Error(
      `Workflow ${workflow.name} has ${workflow.stages.length} Stages, so agentIds must contain ${workflow.stages.length} Agents.`,
    );
  }
}

async function createUploadSessionRecord({
  agentIds,
  initialStatus,
  workflow,
  metadata,
  projectName,
  source,
  targetPath,
  uploadId,
}: PreparedUpload & {
  agentIds: readonly string[];
  initialStatus: AuditStatus;
  workflow: ResolvedWorkflowDefinition;
}) {
  const agents = agentIds.map(createAgent);
  const session = await AuditSession.createAuditSession({
    agents,
    initialStatus,
    metadata,
    projectName: projectName ?? path.basename(targetPath),
    source,
    targetPath,
    workflow,
  });

  session.agentLogger.info(
    {
      uploadId,
      metadata,
      projectName: session.projectName,
      source,
      targetPath,
    },
    "upload_session_created",
  );

  return session;
}

async function createPathSessionRecord({
  agentIds,
  createdAt,
  workflow,
  initialStatus,
  metadata,
  projectName,
  sessionId,
  source,
  targetPath,
}: {
  agentIds: readonly string[];
  createdAt?: string;
  workflow: ResolvedWorkflowDefinition;
  initialStatus: AuditStatus;
  metadata?: TaskMetadata;
  projectName?: string;
  sessionId?: string;
  source?: string;
  targetPath: string;
}) {
  const agents = agentIds.map(createAgent);
  const session = await AuditSession.createAuditSession({
    agents,
    createdAt,
    initialStatus,
    metadata,
    projectName: projectName ?? path.basename(targetPath),
    sessionId,
    source,
    targetPath,
    workflow,
  });

  session.agentLogger.info(
    {
      metadata,
      projectName: session.projectName,
      source,
      targetPath,
    },
    "path_session_created",
  );

  return session;
}

function uploadSessionResult(
  upload: PreparedUpload,
  session: AuditSession,
): UploadSessionResult {
  return {
    workflowId: session.workflowId,
    metadata: upload.metadata,
    projectName: session.projectName,
    sessionDir: session.sessionDirectoryPath,
    sessionId: session.sessionId,
    source: session.source,
    uploadId: upload.uploadId,
  };
}

function pathSessionResult(
  session: AuditSession,
  backupDir?: string,
): PathSessionResult {
  return {
    workflowId: session.workflowId,
    ...(backupDir ? { backupDir } : {}),
    metadata: session.metadata,
    projectName: session.projectName,
    sessionDir: session.sessionDirectoryPath,
    sessionId: session.sessionId,
    source: session.source,
    targetPath: session.targetPath,
  };
}

async function createPreparedUploadSession({
  agentIds,
  run,
  workflow,
  ...upload
}: PreparedUpload & {
  agentIds: readonly string[];
  run: boolean;
  workflow: ResolvedWorkflowDefinition;
}): Promise<UploadSessionResult> {
  const session = await createUploadSessionRecord({
    agentIds,
    ...upload,
    initialStatus: run ? AuditStatus.QUEUED : AuditStatus.WAIT,
    workflow,
  });

  const queuedUpload: PreparedUpload = {
    ...upload,
    projectName: session.projectName,
    source: session.source,
  };

  await upsertUploadStateToDb(queuedUpload);
  if (run) {
    await getSessionQueue().enqueue({
      key: modelProviderQueueKey(agentIds),
      sessionId: session.sessionId,
    });
  }

  return uploadSessionResult(queuedUpload, session);
}

async function backupAndClearSessionDirectory({
  projectRoot,
  sessionId,
}: {
  projectRoot: string;
  sessionId: string;
}) {
  const sessionDir = path.join(projectRoot, ".data", "session", sessionId);
  let backupDir: string | undefined;

  if (await pathExists(sessionDir)) {
    const backupRoot = path.join(
      projectRoot,
      ".data",
      "session-rerun-backups",
      sessionId,
    );
    const backupIndex = await nextSessionBackupIndex(backupRoot);
    backupDir = path.join(
      backupRoot,
      `${backupIndex.toString().padStart(6, "0")}-${backupTimestamp()}-${randomBytes(4).toString("hex")}`,
    );
    await mkdir(path.dirname(backupDir), { recursive: true });
    await cp(sessionDir, backupDir, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }

  await rm(sessionDir, { force: true, recursive: true });
  return backupDir;
}

async function nextSessionBackupIndex(backupRoot: string) {
  const entries = await readdir(backupRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const maxIndex = entries.reduce((max, entry) => {
    if (!entry.isDirectory()) {
      return max;
    }

    const match = /^(\d+)-/.exec(entry.name);
    if (!match) {
      return max;
    }

    const index = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(index) ? Math.max(max, index) : max;
  }, 0);

  return maxIndex + 1;
}

async function removeExcludedUploadPaths({
  excludedPaths,
  upload,
}: {
  excludedPaths: string[];
  upload: UploadState;
}) {
  const normalizedExcludedPaths = compactCoveredUploadPaths(
    excludedPaths.map((excludedPath) =>
      normalizeUploadRelativePath(excludedPath, { allowEmpty: false }),
    ),
  );

  for (const excludedPath of normalizedExcludedPaths) {
    await rm(resolveUploadTargetChildPath(upload.targetPath, excludedPath), {
      force: true,
      recursive: true,
    });
  }

  return upload;
}

function compactCoveredUploadPaths(paths: string[]) {
  const uniquePaths = [...new Set(paths)].sort((left, right) => {
    const leftDepth = left.split("/").length;
    const rightDepth = right.split("/").length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
  const compactedPaths: string[] = [];

  for (const candidate of uniquePaths) {
    if (
      compactedPaths.some(
        (parent) => candidate === parent || candidate.startsWith(`${parent}/`),
      )
    ) {
      continue;
    }
    compactedPaths.push(candidate);
  }

  return compactedPaths;
}

function normalizeUploadRelativePath(
  value: string,
  { allowEmpty }: { allowEmpty: boolean },
) {
  const normalizedSeparators = value.trim().replace(/\\/g, "/");
  if (!normalizedSeparators) {
    if (allowEmpty) {
      return "";
    }
    throw new Error("Upload path cannot be empty.");
  }

  if (
    normalizedSeparators.includes("\0") ||
    path.posix.isAbsolute(normalizedSeparators)
  ) {
    throw new Error(`Invalid Upload path: ${value}`);
  }

  const segments = normalizedSeparators.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid Upload path: ${value}`);
  }

  return segments.join("/");
}

function resolveUploadTargetChildPath(
  targetPath: string,
  relativePath: string,
) {
  const absoluteTargetPath = path.resolve(targetPath);
  const resolvedPath = path.resolve(absoluteTargetPath, relativePath);
  const relativeResolvedPath = path.relative(absoluteTargetPath, resolvedPath);

  if (
    relativeResolvedPath.startsWith("..") ||
    path.isAbsolute(relativeResolvedPath)
  ) {
    throw new Error(`Upload path escapes its root: ${relativePath}`);
  }

  return resolvedPath;
}

function normalizeProjectName(projectName: string | undefined) {
  const normalized = projectName?.trim();
  return normalized || undefined;
}

function projectNameFromArchiveName(archiveName: string) {
  return normalizeProjectName(
    path.basename(archiveName, path.extname(archiveName)),
  );
}

async function resolveLocalTargetPath(projectRoot: string, targetPath: string) {
  const normalized = targetPath.trim() || "mock";

  if (normalized.includes("\0")) {
    throw new Error(`Invalid project path: ${targetPath}`);
  }

  const resolvedPath = path.resolve(projectRoot, normalized);
  // Keep user-selected local projects out of standalone trace globs.
  const targetStat = await Reflect.apply(stat, undefined, [resolvedPath]).catch(
    () => null,
  );

  if (!targetStat) {
    throw new Error(`Project path not found: ${resolvedPath}`);
  }

  if (!targetStat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}

async function pathExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertSafeUploadId(uploadId: string) {
  if (!/^\d{14}-[a-f0-9]{12}$/.test(uploadId)) {
    throw new Error(`Invalid upload ID: ${uploadId}`);
  }
}

function assertSafeSessionId(sessionId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

async function resolveUploadTargetPath(
  extractDir: string,
  archiveName: string,
) {
  const archiveRootName = path.basename(archiveName, path.extname(archiveName));
  const entries = await readdir(extractDir, { withFileTypes: true });
  const matchingRoot = entries.find(
    (entry) => entry.isDirectory() && entry.name === archiveRootName,
  );
  if (matchingRoot) {
    return path.join(extractDir, matchingRoot.name);
  }

  const visibleEntries = entries.filter((entry) => entry.name !== "__MACOSX");
  const onlyEntry = visibleEntries.length === 1 ? visibleEntries[0] : undefined;
  return onlyEntry?.isDirectory()
    ? path.join(extractDir, onlyEntry.name)
    : extractDir;
}

function assertZipArchive(archive: UploadArchive) {
  const fileName = archive.name.toLowerCase();

  if (!fileName.endsWith(".zip")) {
    throw new Error("Only .zip archives are supported.");
  }
}

function assertZipMagic(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error("The file is not a valid ZIP archive.");
  }
}

function createUploadId() {
  const timestamp = formatUploadTimestamp(new Date());
  const randomSuffix = randomBytes(Math.ceil(UPLOAD_RANDOM_ID_LENGTH / 2))
    .toString("hex")
    .slice(0, UPLOAD_RANDOM_ID_LENGTH);

  return `${timestamp}-${randomSuffix}`;
}

function formatUploadTimestamp(date: Date) {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

async function extractZip(zipPath: string, extractDir: string) {
  const zipfile = await openZip(zipPath);

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      zipfile.close();
      reject(error);
    };

    zipfile.on("entry", (entry: Entry) => {
      handleZipEntry(zipfile, entry, extractDir).catch(fail);
    });
    zipfile.once("end", resolve);
    zipfile.once("error", fail);
    zipfile.readEntry();
  });
}

function openZip(zipPath: string) {
  return new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipfile) => {
        if (error) {
          reject(error);
          return;
        }

        if (!zipfile) {
          reject(new Error("Unable to open the ZIP archive."));
          return;
        }

        resolve(zipfile);
      },
    );
  });
}

async function handleZipEntry(
  zipfile: ZipFile,
  entry: Entry,
  extractDir: string,
) {
  if (isZipDirectory(entry)) {
    await mkdir(resolveExtractPath(extractDir, entry.fileName), {
      recursive: true,
    });
    zipfile.readEntry();
    return;
  }

  if (isZipSymlink(entry)) {
    throw new Error(
      `ZIP archives cannot contain symbolic links: ${entry.fileName}`,
    );
  }

  const outputPath = resolveExtractPath(extractDir, entry.fileName);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const readStream = await openEntryReadStream(zipfile, entry);
  await pipeline(readStream, createWriteStream(outputPath, { flags: "wx" }));
  zipfile.readEntry();
}

function openEntryReadStream(zipfile: ZipFile, entry: Entry) {
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zipfile.openReadStream(entry, (error, readStream) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(readStream);
    });
  });
}

function resolveExtractPath(extractDir: string, entryName: string) {
  if (!entryName || entryName.includes("\0")) {
    throw new Error("The ZIP archive contains an invalid path.");
  }

  const normalizedEntryName = entryName.replace(/\\/g, "/");
  const outputPath = path.resolve(extractDir, normalizedEntryName);
  const relativePath = path.relative(extractDir, outputPath);

  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `The ZIP archive contains an out-of-bounds path: ${entryName}`,
    );
  }

  return outputPath;
}

function isZipDirectory(entry: Entry) {
  return entry.fileName.endsWith("/");
}

function isZipSymlink(entry: Entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

async function removeMacosMetadata(extractDir: string) {
  await rm(path.join(extractDir, "__MACOSX"), {
    force: true,
    recursive: true,
  });
}
