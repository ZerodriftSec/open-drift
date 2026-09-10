import type { AuditSession } from "@/audit/session";
import {
  findingInputSchema,
  normalizeFindingMarkdownText,
  type Finding,
  type FindingInput,
} from "@/audit/session/types";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export async function parseFindingInput(
  input: unknown,
  workingDirectory: string,
  sourceManifest: ReadonlySet<string>,
): Promise<Finding> {
  return validateFindingPaths(
    normalizeIncomingFinding(toFinding(findingInputSchema.parse(input))),
    workingDirectory,
    sourceManifest,
  );
}

function normalizeIncomingFinding(finding: Finding): Finding {
  const title = finding.title.trim();
  const description = normalizeFindingMarkdownText(finding.description).trim();
  const rootCause =
    normalizeFindingMarkdownText(finding.root_cause).trim() || title;
  const impact =
    normalizeFindingMarkdownText(finding.impact).trim() || description;
  const filePath = finding.file_path.trim();

  if (!title) throw new Error("Finding title is required");
  if (!description) throw new Error("Finding description is required");
  if (!rootCause) throw new Error("Finding root_cause is required");
  if (!impact) throw new Error("Finding impact is required");
  if (!filePath) throw new Error("Finding file_path is required");

  return {
    ...finding,
    description,
    economic_impact: normalizeOptionalFindingMarkdownText(
      finding.economic_impact,
    ),
    file_path: filePath,
    impact,
    note: normalizeOptionalFindingMarkdownText(finding.note),
    recommendation: normalizeOptionalFindingMarkdownText(
      finding.recommendation,
    ),
    root_cause: rootCause,
    source_locations: finding.source_locations?.map((location) => ({
      ...location,
      file: location.file.trim(),
      snippet: normalizeOptionalFindingText(location.snippet),
    })),
    title,
    triggered_actor: normalizeOptionalFindingMarkdownText(
      finding.triggered_actor,
    ),
    trigger_conditions: normalizeOptionalFindingMarkdownText(
      finding.trigger_conditions,
    ),
  };
}

function normalizeOptionalFindingMarkdownText(
  value: string | null | undefined,
) {
  if (value === null) return null;
  const normalized = value && normalizeFindingMarkdownText(value).trim();
  return normalized || undefined;
}

function normalizeOptionalFindingText(value: string | null | undefined) {
  if (value === null) return null;
  const normalized = value?.trim();
  return normalized || undefined;
}

export async function validateFindingPaths(
  finding: Finding,
  workingDirectory: string,
  sourceManifest?: ReadonlySet<string>,
): Promise<Finding> {
  const sourceLocations = finding.source_locations
    ? await Promise.all(
        finding.source_locations.map(async (location, index) => ({
          ...location,
          file: await validateFindingFilePath(
            location.file,
            workingDirectory,
            `source_locations[${index}].file`,
            sourceManifest,
          ),
        })),
      )
    : undefined;

  return {
    ...finding,
    file_path: await validateFindingFilePath(
      finding.file_path,
      workingDirectory,
      "file_path",
      sourceManifest,
    ),
    source_locations: sourceLocations,
  };
}

async function validateFindingFilePath(
  filePath: string,
  workingDirectory: string,
  field: string,
  sourceManifest?: ReadonlySet<string>,
): Promise<string> {
  const resolvedWorkingDirectory = await realpath(workingDirectory);
  const candidatePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workingDirectory, filePath);

  let resolvedFilePath: string;
  try {
    resolvedFilePath = await realpath(candidatePath);
  } catch {
    throw new Error(
      `Finding ${field} must reference an existing file inside the session working directory: ${filePath}`,
    );
  }

  const relativePath = path.relative(
    resolvedWorkingDirectory,
    resolvedFilePath,
  );
  const fileStat = await stat(resolvedFilePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    !fileStat.isFile()
  ) {
    throw new Error(
      `Finding ${field} must reference an existing file inside the session working directory: ${filePath}`,
    );
  }

  const normalizedPath = relativePath.replaceAll(path.sep, "/");
  if (sourceManifest && !sourceManifest.has(normalizedPath)) {
    throw new Error(
      `Finding ${field} must reference a file in the session source manifest; agent-generated files are not valid source evidence: ${filePath}`,
    );
  }

  return normalizedPath;
}

export async function captureFindingSourceManifest(workingDirectory: string) {
  const root = await realpath(workingDirectory);
  const manifest = new Set<string>();
  const ignoredDirectories = new Set([
    ".agents",
    ".claude",
    ".codex",
    ".data",
    ".gemini",
    ".git",
    "node_modules",
  ]);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, await realpath(entryPath));
        if (
          relativePath &&
          relativePath !== ".." &&
          !relativePath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativePath)
        ) {
          manifest.add(relativePath.replaceAll(path.sep, "/"));
        }
      }
    }
  };
  await visit(root);
  return manifest as ReadonlySet<string>;
}

export async function captureSessionSourceManifest(session: AuditSession) {
  const sourcePath = path.resolve(session.targetPath);
  const sourceStat = await stat(sourcePath);
  if (sourceStat.isDirectory()) {
    return captureFindingSourceManifest(sourcePath);
  }
  if (sourceStat.isFile()) {
    return new Set([path.basename(sourcePath)]) as ReadonlySet<string>;
  }
  throw new Error(`Unsupported audit source path: ${sourcePath}`);
}

function toFinding({ source_locations, ...input }: FindingInput): Finding {
  return {
    ...input,
    ...(source_locations == null ? {} : { source_locations }),
  };
}
