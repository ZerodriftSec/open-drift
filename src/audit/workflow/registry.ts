import { WorkflowDefinition } from "@/audit/workflow";
import { listAuditSkillNames } from "@/audit/agent/skills";
import {
  workflowDocumentInputSchema,
  workflowSkillSelectionSchema,
} from "@/audit/workflow/schema";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CodeDefinedWorkflow = {
  category?: string;
  definition: WorkflowDefinition;
  description?: string;
};

export function codeWorkflowName(workflow: CodeDefinedWorkflow) {
  const name = workflow.definition.name?.trim();
  if (!name) {
    throw new Error("Code Workflow name must not be empty.");
  }
  return name;
}

const discoveredCodeWorkflows = await discoverCodeWorkflows();
const availableCodeWorkflowSkillNames = await listAuditSkillNames();

export const registeredCodeWorkflows: readonly CodeDefinedWorkflow[] =
  validateCodeWorkflowRegistry(
    discoveredCodeWorkflows.map(({ workflow }) => workflow),
    availableCodeWorkflowSkillNames,
  );
const codeWorkflowByName = new Map(
  registeredCodeWorkflows.map((workflow) => [
    codeWorkflowName(workflow),
    workflow,
  ]),
);

async function discoverCodeWorkflows() {
  const directory = await codeWorkflowDirectory();
  const entries = (
    await readdir(/*turbopackIgnore: true*/ directory, {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (entries.length === 0) {
    throw new Error(`No Code Workflow JSON documents found in ${directory}.`);
  }

  return Promise.all(
    entries.map(async ({ name: fileName }) => {
      try {
        // Keep runtime-selected Workflow files out of standalone trace globs.
        const filePath = Reflect.apply(path.join, undefined, [
          directory,
          fileName,
        ]) as string;
        const content = (await Reflect.apply(readFile, undefined, [
          filePath,
          "utf8",
        ])) as string;
        const document = workflowDocumentInputSchema.parse(
          JSON.parse(content) as unknown,
        );
        const definition = WorkflowDefinition.parse(document);
        return {
          fileName,
          workflow: {
            category: document.category,
            definition,
            description: document.description,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid Code Workflow ${fileName}: ${message}`);
      }
    }),
  );
}

async function codeWorkflowDirectory() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), "workflows"),
    path.join(moduleDirectory, "workflows"),
    path.join(moduleDirectory, "..", "..", "..", "workflows"),
  ];

  for (const directory of new Set(candidates)) {
    try {
      await access(directory);
      return directory;
    } catch {
      // Try the next source or bundled module location.
    }
  }
  throw new Error("Code Workflow documents directory does not exist.");
}

export function validateCodeWorkflowRegistry(
  workflows: readonly CodeDefinedWorkflow[],
  availableSkillNames: readonly string[] = availableCodeWorkflowSkillNames,
) {
  const names = new Set<string>();
  for (const workflow of workflows) {
    const name = codeWorkflowName(workflow);
    if (names.has(name)) {
      throw new Error(`Code Workflow name must be unique: ${name}`);
    }
    names.add(name);
    validateWorkflowSkills(
      workflow.definition,
      availableSkillNames,
      `Code Workflow ${name}`,
    );
  }
  return workflows;
}

export function validateWorkflowSkills(
  definition: WorkflowDefinition,
  availableSkillNames: readonly string[],
  contextPrefix = `Workflow ${definition.name ?? "(unnamed)"}`,
) {
  const availableSkillNameSet = new Set(availableSkillNames);
  for (const stage of definition.stages) {
    for (const [turnIndex, turn] of stage.turns.entries()) {
      const context = `${contextPrefix} Stage ${stage.name} Turn ${turn.name?.trim() || turnIndex + 1}`;
      if (turn.skills === undefined) continue;
      const selection = workflowSkillSelectionSchema.safeParse(turn.skills);
      if (!selection.success) {
        throw new Error(
          `${context} has invalid skills: ${selection.error.issues[0]?.message}`,
        );
      }

      for (const skillName of selection.data.names ?? []) {
        if (!availableSkillNameSet.has(skillName)) {
          throw new Error(`${context} references unknown Skill: ${skillName}`);
        }
      }

      for (const prefix of selection.data.prefixes ?? []) {
        if (![...availableSkillNames].some((name) => name.startsWith(prefix))) {
          throw new Error(`${context} has unmatched Skill prefix: ${prefix}`);
        }
      }
    }
  }
}

export function getCodeDefinedWorkflow(workflowName: string) {
  return codeWorkflowByName.get(workflowName.trim());
}
