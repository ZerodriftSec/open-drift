import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { normalizeAgentId } from "@/audit/agent/registry";
import { listAuditSkillNames } from "@/audit/agent/skills";
import { WorkflowDefinition, type WorkflowStage } from "@/audit/workflow";
import {
  codeWorkflowName,
  getCodeDefinedWorkflow,
  registeredCodeWorkflows,
  validateWorkflowSkills,
} from "@/audit/workflow/registry";
import {
  workflowDocumentInputSchema,
  type WorkflowDocumentInput,
} from "@/audit/workflow/schema";

const workflowStorageDirectory = () =>
  path.join(process.cwd(), ".data", "workflow");

export type WorkflowDocument = Omit<WorkflowDocumentInput, "stages"> & {
  stages: readonly WorkflowStage[];
};

export type WorkflowDefinitionSummary = {
  category?: string;
  defaultModel?: string;
  description?: string;
  id: string;
  label: string;
  source: "code" | "file";
  stageCount: number;
  stageIds: string[];
};

export type WorkflowDocumentRecord = {
  document: WorkflowDocument;
  id: string;
  readOnly: boolean;
  source: "code" | "file";
};

export type ResolvedWorkflowDefinition = WorkflowDefinition & {
  readonly id: string;
  readonly stageIds: readonly string[];
};

export async function listWorkflowDefinitions(): Promise<
  WorkflowDefinitionSummary[]
> {
  const availableSkillNames = await listAuditSkillNames();
  const codeIds = new Set(
    registeredCodeWorkflows.map((workflow) => codeWorkflowName(workflow)),
  );
  const localRecords = await Promise.all(
    (await listLocalWorkflowIds()).map(async (id) => {
      if (codeIds.has(id)) {
        throw new Error(
          `Local Workflow file ID conflicts with a code-defined Workflow: ${id}`,
        );
      }
      return readLocalWorkflow(id, availableSkillNames);
    }),
  );

  return [
    ...registeredCodeWorkflows.map((workflow) => {
      const id = codeWorkflowName(workflow);
      return workflowSummary(id, codeWorkflowDocument(workflow), "code");
    }),
    ...localRecords.map(({ document, id }) =>
      workflowSummary(id, document, "file"),
    ),
  ].sort((left, right) => left.label.localeCompare(right.label, "en-US"));
}

export async function getDefaultWorkflowId() {
  return (await listWorkflowDefinitions())[0]?.id ?? "";
}

export async function createWorkflow(document: unknown) {
  const normalized = await validateWorkflowDocumentWithInstalledSkills(
    document,
    "New Workflow",
  );
  const id = randomUUID();
  await writeLocalWorkflow(id, normalized);
  return workflowDocumentRecord(id, normalized, "file");
}

export async function getWorkflowDocument(
  workflowId: string,
): Promise<WorkflowDocumentRecord> {
  const codeDefined = getCodeDefinedWorkflow(workflowId);
  if (codeDefined) {
    return workflowDocumentRecord(
      codeWorkflowName(codeDefined),
      codeWorkflowDocument(codeDefined),
      "code",
    );
  }

  const { document, id } = await readLocalWorkflow(
    workflowId,
    await listAuditSkillNames(),
  );
  return workflowDocumentRecord(id, document, "file");
}

export async function saveWorkflow(workflowId: string, document: unknown) {
  assertLocalWorkflowId(workflowId);
  if (getCodeDefinedWorkflow(workflowId)) {
    throw new Error(`Workflow ${workflowId} is defined in code and read-only.`);
  }
  await assertLocalWorkflowExists(workflowId);
  const normalized = await validateWorkflowDocumentWithInstalledSkills(
    document,
    `Workflow ${workflowId}`,
  );
  await writeLocalWorkflow(workflowId, normalized);
  return workflowDocumentRecord(workflowId, normalized, "file");
}

export async function deleteWorkflow(workflowId: string) {
  if (getCodeDefinedWorkflow(workflowId)) {
    throw new Error(`Workflow ${workflowId} is defined in code and read-only.`);
  }
  assertLocalWorkflowId(workflowId);
  try {
    await unlink(localWorkflowFilePath(workflowId));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`Workflow ${workflowId} not found.`);
    }
    throw error;
  }
}

export async function getWorkflowDefinition(
  workflowId: string,
): Promise<ResolvedWorkflowDefinition> {
  const record = await getWorkflowDocument(workflowId);
  const definition = new WorkflowDefinition({
    defaultModel: record.document.defaultModel,
    name: record.document.name,
    stages: record.document.stages,
  });
  return Object.assign(definition, {
    id: record.id,
    stageIds: workflowStageIds(record.id, definition.stages.length),
  });
}

export function validateWorkflowDocument(
  document: unknown,
  availableSkillNames: readonly string[],
  context?: string,
): WorkflowDocument {
  const parsed = workflowDocumentInputSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new Error(
      `Invalid Workflow JSON${location}: ${issue?.message ?? "Unknown validation error"}`,
    );
  }

  const definition = new WorkflowDefinition({
    defaultModel: parsed.data.defaultModel,
    name: parsed.data.name,
    stages: parsed.data.stages,
  });
  validateWorkflowSkills(
    definition,
    availableSkillNames,
    context ?? `Workflow ${definition.name}`,
  );
  return {
    name: definition.name!,
    ...(parsed.data.category === undefined
      ? {}
      : { category: parsed.data.category }),
    ...(definition.defaultModel === undefined
      ? {}
      : { defaultModel: definition.defaultModel }),
    ...(parsed.data.description === undefined
      ? {}
      : { description: parsed.data.description }),
    stages: definition.stages,
  };
}

export function workflowStageIds(workflowId: string, stageCount: number) {
  const stageIds: string[] = [];
  for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
    stageIds.push(`${workflowId}:stage:${stageIndex}`);
  }
  return stageIds;
}

export function resolveWorkflowAgentId(
  value: unknown,
  workflow: WorkflowDefinition,
) {
  const agentId = typeof value === "string" ? value.trim() : "";
  try {
    return normalizeAgentId(agentId);
  } catch (error) {
    if (workflow.defaultModel === undefined) throw error;
    return normalizeAgentId(workflow.defaultModel);
  }
}

async function validateWorkflowDocumentWithInstalledSkills(
  document: unknown,
  context: string,
) {
  return validateWorkflowDocument(
    document,
    await listAuditSkillNames(),
    context,
  );
}

function codeWorkflowDocument(
  workflow: (typeof registeredCodeWorkflows)[number],
): WorkflowDocument {
  return {
    name: codeWorkflowName(workflow),
    ...(workflow.category === undefined ? {} : { category: workflow.category }),
    ...(workflow.definition.defaultModel === undefined
      ? {}
      : { defaultModel: workflow.definition.defaultModel }),
    ...(workflow.description === undefined
      ? {}
      : { description: workflow.description }),
    stages: workflow.definition.stages,
  };
}

function workflowSummary(
  id: string,
  document: WorkflowDocument,
  source: WorkflowDefinitionSummary["source"],
): WorkflowDefinitionSummary {
  return {
    category: document.category,
    defaultModel: document.defaultModel,
    description: document.description,
    id,
    label: document.name,
    source,
    stageCount: document.stages.length,
    stageIds: workflowStageIds(id, document.stages.length),
  };
}

function workflowDocumentRecord(
  id: string,
  document: WorkflowDocument,
  source: WorkflowDocumentRecord["source"],
): WorkflowDocumentRecord {
  return {
    document,
    id,
    readOnly: source === "code",
    source,
  };
}

async function listLocalWorkflowIds() {
  let entries;
  try {
    entries = await readdir(workflowStorageDirectory(), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort((left, right) => left.localeCompare(right));
}

async function readLocalWorkflow(
  workflowId: string,
  availableSkillNames: readonly string[],
) {
  assertLocalWorkflowId(workflowId);
  let content;
  try {
    content = await readFile(localWorkflowFilePath(workflowId), "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`Workflow ${workflowId} not found.`);
    }
    throw error;
  }

  let document: unknown;
  try {
    document = JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid Workflow JSON file ${workflowId}.json: ${message}`,
    );
  }

  return {
    document: validateWorkflowDocument(
      document,
      availableSkillNames,
      `Workflow ${workflowId}`,
    ),
    id: workflowId,
  };
}

async function assertLocalWorkflowExists(workflowId: string) {
  try {
    await readFile(localWorkflowFilePath(workflowId), "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`Workflow ${workflowId} not found.`);
    }
    throw error;
  }
}

async function writeLocalWorkflow(
  workflowId: string,
  document: WorkflowDocument,
) {
  const directory = workflowStorageDirectory();
  await mkdir(directory, { recursive: true });
  const target = localWorkflowFilePath(workflowId);
  const temporary = path.join(directory, `.${workflowId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function localWorkflowFilePath(workflowId: string) {
  assertLocalWorkflowId(workflowId);
  return path.join(workflowStorageDirectory(), `${workflowId}.json`);
}

function assertLocalWorkflowId(workflowId: string) {
  if (
    !workflowId ||
    workflowId.length > 200 ||
    workflowId === "." ||
    workflowId === ".." ||
    workflowId.includes("/") ||
    workflowId.includes("\\") ||
    workflowId.includes("\0")
  ) {
    throw new Error(`Invalid Workflow ID: ${workflowId}`);
  }
}

function isNodeError(error: unknown, code: string) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
