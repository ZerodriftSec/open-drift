import {
  isLegacyFindingMcpName,
  isWorkflowOutputSchemaName,
  legacyFindingOutputSchema,
  type WorkflowOutputSchemaName,
} from "@/audit/output/names";

export type WorkflowSkillSelection = {
  names?: readonly string[];
  prefixes?: readonly string[];
};

export type WorkflowTurn = {
  name?: string;
  prompt: string;
  goal?: boolean;
  skills?: WorkflowSkillSelection;
  mcp?: readonly string[];
  outputSchema?: WorkflowOutputSchemaName;
  beforeHooks?: readonly string[];
  afterHooks?: readonly string[];
};

export type WorkflowStage = {
  name: string;
  dependsOn?: readonly string[];
  threadMode?: WorkflowThreadMode;
  turns: readonly WorkflowTurn[];
};

export type WorkflowThreadMode = "new" | "fork" | "resume";

type SerializedWorkflowTurn = Omit<WorkflowTurn, "name"> & {
  label?: string;
  name?: string;
};

type SerializedWorkflowStage = Omit<WorkflowStage, "name" | "turns"> & {
  label?: string;
  name?: string;
  turns: readonly SerializedWorkflowTurn[];
};

export class WorkflowDefinition {
  readonly defaultModel?: string;
  readonly name?: string;
  readonly stages: readonly WorkflowStage[];

  static parse(document: unknown) {
    return new WorkflowDefinition(parseWorkflowDocument(document));
  }

  static deserialize(serialized: string) {
    const definition = JSON.parse(serialized) as {
      defaultModel?: unknown;
      label?: string;
      name?: string;
      stages: readonly SerializedWorkflowStage[];
    };
    return new WorkflowDefinition({
      defaultModel: normalizeWorkflowDefaultModel(definition.defaultModel),
      name: definition.name?.trim() || definition.label?.trim(),
      stages: definition.stages.map(
        ({ label: legacyName, name, turns, ...stage }, stageIndex) => ({
          ...stage,
          name: name?.trim() || legacyName?.trim() || `Stage ${stageIndex + 1}`,
          turns: turns.map(({ label: legacyName, name, ...turn }) => ({
            ...turn,
            ...(name === undefined && legacyName === undefined
              ? {}
              : { name: name ?? legacyName }),
          })),
        }),
      ),
    });
  }

  constructor(definition: {
    defaultModel?: string;
    name?: string;
    stages: readonly WorkflowStage[];
  }) {
    this.defaultModel = normalizeWorkflowDefaultModel(definition.defaultModel);
    this.name = definition.name;
    this.stages = normalizeWorkflowStages(definition.stages);
  }

  toJSON() {
    return {
      ...(this.defaultModel === undefined
        ? {}
        : { defaultModel: this.defaultModel }),
      ...(this.name === undefined ? {} : { name: this.name }),
      stages: this.stages,
    };
  }

  serialize() {
    return JSON.stringify(this);
  }
}

function parseWorkflowDocument(document: unknown): {
  defaultModel?: string;
  name: string;
  stages: readonly WorkflowStage[];
} {
  if (!isRecord(document)) {
    throw new Error("Workflow definition must be an object.");
  }
  const name = typeof document.name === "string" ? document.name.trim() : "";
  if (!name) {
    throw new Error("Workflow name must not be empty.");
  }
  if (!Array.isArray(document.stages) || document.stages.length === 0) {
    throw new Error(`Workflow ${name} must have at least one Stage.`);
  }

  return {
    ...(document.defaultModel === undefined
      ? {}
      : { defaultModel: normalizeWorkflowDefaultModel(document.defaultModel) }),
    name,
    stages: document.stages.map((value, stageIndex) => {
      if (!isRecord(value)) {
        throw new Error(`Workflow ${name} Stage ${stageIndex + 1} is invalid.`);
      }
      const stageName = typeof value.name === "string" ? value.name.trim() : "";
      if (!stageName) {
        throw new Error(
          `Workflow ${name} Stage ${stageIndex + 1} name must not be empty.`,
        );
      }
      if (
        !Array.isArray(value.dependsOn) ||
        !value.dependsOn.every((dependency) => typeof dependency === "string")
      ) {
        throw new Error(
          `Workflow ${name} Stage ${stageName} must explicitly define dependsOn.`,
        );
      }
      if (
        value.threadMode !== "new" &&
        value.threadMode !== "fork" &&
        value.threadMode !== "resume"
      ) {
        throw new Error(
          `Workflow ${name} Stage ${stageName} must explicitly choose threadMode new, fork, or resume.`,
        );
      }
      if (!Array.isArray(value.turns) || value.turns.length === 0) {
        throw new Error(
          `Workflow ${name} Stage ${stageName} must have at least one Turn.`,
        );
      }

      return {
        ...value,
        name: stageName,
        dependsOn: value.dependsOn,
        threadMode: value.threadMode,
        turns: value.turns.map((turnValue, turnIndex) => {
          if (!isRecord(turnValue)) {
            throw new Error(
              `Workflow ${name} Stage ${stageName} Turn ${turnIndex + 1} is invalid.`,
            );
          }
          const prompt = normalizeWorkflowDocumentPrompt(turnValue.prompt);
          if (!prompt?.trim()) {
            throw new Error(
              `Workflow ${name} Stage ${stageName} Turn ${turnIndex + 1} prompt must not be empty.`,
            );
          }
          return { ...turnValue, prompt } as WorkflowTurn;
        }),
      } as WorkflowStage;
    }),
  };
}

function normalizeWorkflowDefaultModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Workflow defaultModel must not be empty.");
  }
  return value.trim();
}

function normalizeWorkflowDocumentPrompt(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) {
    return value.join("\n");
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkflowStages(
  stages: readonly WorkflowStage[],
): readonly WorkflowStage[] {
  if (stages.length === 0) return [];

  const normalized = stages.map((stage) => ({
    ...stage,
    name: stage.name.trim(),
    turns: stage.turns.map(normalizeWorkflowTurn),
    ...(stage.dependsOn === undefined
      ? {}
      : { dependsOn: stage.dependsOn.map((name) => name.trim()) }),
  }));
  const usesExplicitDependencies = normalized.some(
    (stage) => stage.dependsOn !== undefined,
  );
  const prepared = usesExplicitDependencies
    ? normalized
    : normalized.map((stage, stageIndex) => ({
        ...stage,
        ...(stageIndex === 0
          ? {}
          : { dependsOn: [normalized[stageIndex - 1]!.name] }),
      }));

  return topologicallyOrderedStages(prepared);
}

function normalizeWorkflowTurn(turn: WorkflowTurn): WorkflowTurn {
  const {
    afterHooks,
    beforeHooks,
    goal,
    mcp,
    name,
    outputSchema,
    prompt,
    skills,
  } = turn;
  if (outputSchema !== undefined && !isWorkflowOutputSchemaName(outputSchema)) {
    throw new Error(`Invalid Workflow outputSchema: ${outputSchema}`);
  }
  const normalizedMcp = mcp?.filter((name) => !isLegacyFindingMcpName(name));
  const normalizedOutputSchema = outputSchema ?? legacyFindingOutputSchema(mcp);
  return {
    ...(name === undefined ? {} : { name }),
    prompt,
    ...(goal === undefined ? {} : { goal }),
    ...(skills === undefined ? {} : { skills }),
    ...(normalizedMcp === undefined ? {} : { mcp: normalizedMcp }),
    ...(normalizedOutputSchema === undefined
      ? {}
      : { outputSchema: normalizedOutputSchema }),
    ...(beforeHooks === undefined ? {} : { beforeHooks }),
    ...(afterHooks === undefined ? {} : { afterHooks }),
  };
}

function topologicallyOrderedStages(
  stages: readonly WorkflowStage[],
): readonly WorkflowStage[] {
  const byName = new Map<string, WorkflowStage>();
  const declarationIndex = new Map<string, number>();
  for (const [stageIndex, stage] of stages.entries()) {
    if (!stage.name) {
      throw new Error("Workflow Stage name must not be empty.");
    }
    if (byName.has(stage.name)) {
      throw new Error(`Workflow Stage name must be unique: ${stage.name}`);
    }
    if (
      stage.threadMode !== undefined &&
      stage.threadMode !== "new" &&
      stage.threadMode !== "fork" &&
      stage.threadMode !== "resume"
    ) {
      throw new Error(
        `Workflow Stage ${stage.name} has invalid threadMode: ${stage.threadMode}`,
      );
    }
    byName.set(stage.name, stage);
    declarationIndex.set(stage.name, stageIndex);
  }

  const indegree = new Map(stages.map((stage) => [stage.name, 0]));
  const successors = new Map(
    stages.map((stage) => [stage.name, [] as string[]]),
  );
  for (const stage of stages) {
    const dependencies = stage.dependsOn ?? [];
    const uniqueDependencies = new Set(dependencies);
    if (uniqueDependencies.size !== dependencies.length) {
      throw new Error(
        `Workflow Stage ${stage.name} has duplicate dependencies.`,
      );
    }
    for (const dependency of dependencies) {
      if (dependency === stage.name) {
        throw new Error(
          `Workflow Stage ${stage.name} cannot depend on itself.`,
        );
      }
      if (!byName.has(dependency)) {
        throw new Error(
          `Workflow Stage ${stage.name} depends on unknown Stage: ${dependency}`,
        );
      }
      indegree.set(stage.name, (indegree.get(stage.name) ?? 0) + 1);
      successors.get(dependency)!.push(stage.name);
    }
    if (
      (stage.threadMode === "fork" || stage.threadMode === "resume") &&
      dependencies.length !== 1
    ) {
      const mode = stage.threadMode === "fork" ? "Fork" : "Resume";
      throw new Error(
        `${mode} Workflow Stage ${stage.name} must have exactly one dependency.`,
      );
    }
  }

  const roots = stages.filter((stage) => indegree.get(stage.name) === 0);
  const ready = [...roots];
  const result: WorkflowStage[] = [];
  while (ready.length > 0) {
    ready.sort(
      (left, right) =>
        declarationIndex.get(left.name)! - declarationIndex.get(right.name)!,
    );
    const stage = ready.shift()!;
    result.push(stage);
    for (const successor of successors.get(stage.name) ?? []) {
      const nextIndegree = indegree.get(successor)! - 1;
      indegree.set(successor, nextIndegree);
      if (nextIndegree === 0) ready.push(byName.get(successor)!);
    }
  }

  if (result.length !== stages.length) {
    throw new Error("Workflow must not contain a cycle.");
  }
  if (roots.length !== 1) {
    throw new Error("Workflow must have exactly one entry Stage.");
  }
  return result;
}
