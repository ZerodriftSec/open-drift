import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { WorkflowDefinition } from "@/audit/workflow";
import {
  codeWorkflowName,
  getCodeDefinedWorkflow,
  registeredCodeWorkflows,
  validateCodeWorkflowRegistry,
} from "@/audit/workflow/registry";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflowDefinition,
  getWorkflowDocument,
  listWorkflowDefinitions,
  saveWorkflow,
  validateWorkflowDocument,
} from "@/server/workflows";

const codeWorkflowDocumentsDirectory = fileURLToPath(
  new URL("../workflows", import.meta.url),
);

async function readCodeWorkflowDocuments(): Promise<unknown[]> {
  const entries = await readdir(codeWorkflowDocumentsDirectory, {
    withFileTypes: true,
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(
        async (entry) =>
          JSON.parse(
            await readFile(
              path.join(codeWorkflowDocumentsDirectory, entry.name),
              "utf8",
            ),
          ) as unknown,
      ),
  );
}

describe("WorkflowDefinition DAG", () => {
  test("discovers every built-in Workflow JSON document", async () => {
    const documents = await readCodeWorkflowDocuments();
    const definitions = documents.map((document) =>
      WorkflowDefinition.parse(document),
    );
    expect(registeredCodeWorkflows.map(codeWorkflowName).sort()).toEqual(
      definitions.map(({ name }) => name!).sort(),
    );

    for (const [documentIndex, definition] of definitions.entries()) {
      const workflow = getCodeDefinedWorkflow(definition.name!);
      if (!workflow) {
        throw new Error(`Workflow was not registered: ${definition.name}`);
      }
      const document = documents[documentIndex] as Record<string, unknown>;
      expect(workflow.category).toBe(document.category);
      expect(workflow.description).toBe(document.description);
      expect(workflow.definition.toJSON()).toEqual(definition.toJSON());
    }
  });

  test("rejects a code Workflow that references an unknown Skill", () => {
    const mockWorkflow = {
      definition: new WorkflowDefinition({
        name: "Invalid Skill Workflow",
        stages: [
          {
            name: "Audit",
            turns: [
              {
                prompt: "Audit the project.",
                skills: { names: ["missing-skill"] },
              },
            ],
          },
        ],
      }),
    };

    expect(() =>
      validateCodeWorkflowRegistry([mockWorkflow], ["available-skill"]),
    ).toThrow(
      "Code Workflow Invalid Skill Workflow Stage Audit Turn 1 references unknown Skill: missing-skill",
    );
  });

  test("joins code Workflow prompt lines with newlines", () => {
    const workflow = WorkflowDefinition.parse({
      name: "Prompt array",
      stages: [
        {
          dependsOn: [],
          name: "Only Stage",
          threadMode: "new",
          turns: [{ prompt: ["first line", "second line"] }],
        },
      ],
    });

    expect(workflow.stages[0]?.turns[0]?.prompt).toBe(
      "first line\nsecond line",
    );
  });

  test.each([
    {
      message: "must explicitly define dependsOn",
      stages: [
        {
          name: "A",
          threadMode: "new",
          turns: [{ prompt: "A" }],
        },
      ],
    },
    {
      message: "must explicitly choose threadMode new, fork, or resume",
      stages: [
        {
          dependsOn: [],
          name: "A",
          turns: [{ prompt: "A" }],
        },
      ],
    },
    {
      message: "must have at least one Turn",
      stages: [
        {
          dependsOn: [],
          name: "A",
          threadMode: "new",
          turns: [],
        },
      ],
    },
    {
      message: "prompt must not be empty",
      stages: [
        {
          dependsOn: [],
          name: "A",
          threadMode: "new",
          turns: [{ prompt: "  " }],
        },
      ],
    },
    {
      message: "prompt must not be empty",
      stages: [
        {
          dependsOn: [],
          name: "A",
          threadMode: "new",
          turns: [{ prompt: [] }],
        },
      ],
    },
  ])("validates Workflow documents: $message", ({ message, stages }) => {
    expect(() =>
      WorkflowDefinition.parse({
        name: "Invalid Workflow",
        stages,
      }),
    ).toThrow(message);
  });

  test("keeps legacy definitions linear when dependsOn is omitted", () => {
    const workflow = new WorkflowDefinition({
      stages: [
        { name: "A", turns: [{ prompt: "A" }] },
        { name: "B", turns: [{ prompt: "B" }] },
        { name: "C", turns: [{ prompt: "C" }] },
      ],
    });

    expect(workflow.stages.map((stage) => stage.dependsOn)).toEqual([
      undefined,
      ["A"],
      ["B"],
    ]);
  });

  test("drops retired input and output path settings from saved workflows", () => {
    const workflow = WorkflowDefinition.deserialize(
      JSON.stringify({
        label: "Legacy Workflow",
        stages: [
          {
            label: "A",
            turns: [
              {
                inputPaths: ["input.md"],
                label: "legacy turn",
                outputPaths: ["output.md"],
                prompt: "A",
              },
            ],
          },
        ],
      }),
    );

    expect(workflow.toJSON()).toEqual({
      name: "Legacy Workflow",
      stages: [{ name: "A", turns: [{ name: "legacy turn", prompt: "A" }] }],
    });
  });

  test("normalizes retired finding MCPs in saved Session Workflow snapshots", () => {
    const workflow = WorkflowDefinition.deserialize(
      JSON.stringify({
        stages: [
          {
            name: "Legacy finding stage",
            turns: [
              {
                mcp: ["submit-finding", "contract-state"],
                prompt: "Submit findings",
              },
              {
                mcp: ["submit-finding", "review-finding"],
                prompt: "Legacy multi-capability turn",
              },
            ],
          },
        ],
      }),
    );

    expect(workflow.stages[0]?.turns).toEqual([
      {
        mcp: ["contract-state"],
        outputSchema: "finding.submit",
        prompt: "Submit findings",
      },
      {
        mcp: [],
        prompt: "Legacy multi-capability turn",
      },
    ]);
  });

  test("orders a fork and join graph by name dependencies", () => {
    const workflow = new WorkflowDefinition({
      stages: [
        {
          name: "Report",
          dependsOn: ["Injection", "XSS"],
          turns: [{ prompt: "Report" }],
        },
        { name: "Recon", dependsOn: [], turns: [{ prompt: "Recon" }] },
        {
          name: "XSS",
          dependsOn: ["Recon"],
          threadMode: "fork",
          turns: [{ prompt: "XSS" }],
        },
        {
          name: "Injection",
          dependsOn: ["Recon"],
          threadMode: "fork",
          turns: [{ prompt: "Injection" }],
        },
      ],
    });

    expect(workflow.stages.map((stage) => stage.name)).toEqual([
      "Recon",
      "XSS",
      "Injection",
      "Report",
    ]);
  });

  test("derives stable Stage IDs for discovered code Workflows", async () => {
    const registered = registeredCodeWorkflows[0];
    expect(registered).toBeDefined();
    const workflowName = codeWorkflowName(registered!);
    const workflow = await getWorkflowDefinition(workflowName);
    const summary = (await listWorkflowDefinitions()).find(
      (candidate) => candidate.id === workflow.id,
    );

    expect(workflow.stageIds).toEqual(
      [...workflow.stages.keys()].map(
        (index) => `${workflowName}:stage:${index}`,
      ),
    );
    expect(summary).toMatchObject({
      stageCount: workflow.stages.length,
      stageIds: workflow.stageIds,
    });
  });

  test("lists every discovered code Workflow exactly once", async () => {
    const workflows = await listWorkflowDefinitions();

    for (const registered of registeredCodeWorkflows) {
      const workflowName = codeWorkflowName(registered);
      expect(
        workflows.filter((workflow) => workflow.id === workflowName),
      ).toEqual([
        expect.objectContaining({
          category: registered.category,
          id: workflowName,
          source: "code",
        }),
      ]);
    }
  });

  test.each([
    {
      message: "must be unique",
      stages: [
        { name: "A", turns: [{ prompt: "A" }] },
        { name: "A", turns: [{ prompt: "A again" }] },
      ],
    },
    {
      message: "unknown Stage",
      stages: [
        { name: "A", dependsOn: [], turns: [{ prompt: "A" }] },
        {
          name: "B",
          dependsOn: ["Missing"],
          turns: [{ prompt: "B" }],
        },
      ],
    },
    {
      message: "must not contain a cycle",
      stages: [
        { name: "A", dependsOn: ["B"], turns: [{ prompt: "A" }] },
        { name: "B", dependsOn: ["A"], turns: [{ prompt: "B" }] },
      ],
    },
    {
      message: "exactly one dependency",
      stages: [
        { name: "A", dependsOn: [], turns: [{ prompt: "A" }] },
        {
          name: "B",
          dependsOn: ["A", "C"],
          threadMode: "fork" as const,
          turns: [{ prompt: "B" }],
        },
        { name: "C", dependsOn: ["A"], turns: [{ prompt: "C" }] },
      ],
    },
    {
      message: "exactly one dependency",
      stages: [
        { name: "A", dependsOn: [], turns: [{ prompt: "A" }] },
        {
          name: "B",
          dependsOn: ["A", "C"],
          threadMode: "resume" as const,
          turns: [{ prompt: "B" }],
        },
        { name: "C", dependsOn: ["A"], turns: [{ prompt: "C" }] },
      ],
    },
  ])("rejects invalid graph: $message", ({ message, stages }) => {
    expect(() => new WorkflowDefinition({ stages })).toThrow(message);
  });

  test("persists a complete custom Workflow as one JSON file", async () => {
    const document = {
      name: "Fork JSON test",
      category: "test",
      defaultModel: "claude-glm-5.3-max",
      description: "Pure JSON persistence",
      stages: [
        {
          name: "Recon",
          dependsOn: [],
          threadMode: "new" as const,
          turns: [
            {
              prompt: "Recon",
              goal: true,
              outputSchema: "finding.submit" as const,
            },
          ],
        },
        {
          name: "Injection",
          dependsOn: ["Recon"],
          threadMode: "fork" as const,
          turns: [{ prompt: "Injection" }],
        },
        {
          name: "XSS",
          dependsOn: ["Recon"],
          threadMode: "fork" as const,
          turns: [{ prompt: "XSS" }],
        },
        {
          name: "Report",
          dependsOn: ["Injection", "XSS"],
          threadMode: "new" as const,
          turns: [{ prompt: "Report" }],
        },
      ],
    };
    const created = await createWorkflow(document);
    const filePath = path.join(
      process.cwd(),
      ".data",
      "workflow",
      `${created.id}.json`,
    );
    const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    const workflow = await getWorkflowDefinition(created.id);

    expect(created).toMatchObject({
      document: { name: document.name },
      readOnly: false,
      source: "file",
    });
    expect(Object.keys(stored).sort()).toEqual([
      "category",
      "defaultModel",
      "description",
      "name",
      "stages",
    ]);
    expect(stored).not.toHaveProperty("nodes");
    expect(stored).not.toHaveProperty("edges");
    expect(stored).not.toHaveProperty("viewport");
    expect(
      workflow.stages.map(({ dependsOn, name, threadMode }) => ({
        dependsOn,
        name,
        threadMode,
      })),
    ).toEqual([
      { dependsOn: [], name: "Recon", threadMode: "new" },
      { dependsOn: ["Recon"], name: "Injection", threadMode: "fork" },
      { dependsOn: ["Recon"], name: "XSS", threadMode: "fork" },
      {
        dependsOn: ["Injection", "XSS"],
        name: "Report",
        threadMode: "new",
      },
    ]);
    expect(
      workflow.stages.find((stage) => stage.name === "Recon")?.turns[0]?.goal,
    ).toBe(true);
    expect(
      workflow.stages.find((stage) => stage.name === "Recon")?.turns[0]
        ?.outputSchema,
    ).toBe("finding.submit");
    const summary = (await listWorkflowDefinitions()).find(
      (candidate) => candidate.id === created.id,
    );
    expect(summary).toMatchObject({
      defaultModel: document.defaultModel,
      source: "file",
      stageCount: 4,
      stageIds: workflow.stageIds,
    });

    await saveWorkflow(created.id, {
      ...document,
      description: "Updated JSON",
    });
    await expect(getWorkflowDocument(created.id)).resolves.toMatchObject({
      document: { description: "Updated JSON" },
    });
  });

  test("validates custom Skill names against a mock Skill registry", () => {
    expect(() =>
      validateWorkflowDocument(
        {
          name: "Mock Skill Workflow",
          stages: [
            {
              name: "Audit",
              dependsOn: [],
              threadMode: "new",
              turns: [
                {
                  prompt: "Audit",
                  skills: { names: ["missing-skill"] },
                },
              ],
            },
          ],
        },
        ["available-skill"],
      ),
    ).toThrow(
      "Workflow Mock Skill Workflow Stage Audit Turn 1 references unknown Skill: missing-skill",
    );
  });

  test("rejects an unregistered top-level default model", () => {
    expect(() =>
      validateWorkflowDocument(
        {
          name: "Invalid default model",
          defaultModel: "missing-agent",
          stages: [
            {
              name: "Audit",
              dependsOn: [],
              threadMode: "new",
              turns: [{ prompt: "Audit" }],
            },
          ],
        },
        [],
      ),
    ).toThrow(
      "Invalid Workflow JSON at defaultModel: Workflow defaultModel must reference a registered Agent ID.",
    );
  });

  test("deletes only custom Workflow JSON files", async () => {
    const created = await createWorkflow({
      name: "Delete JSON test",
      stages: [
        {
          name: "Only Stage",
          dependsOn: [],
          threadMode: "new",
          turns: [{ prompt: "Run" }],
        },
      ],
    });
    const filePath = path.join(
      process.cwd(),
      ".data",
      "workflow",
      `${created.id}.json`,
    );

    await expect(access(filePath)).resolves.toBeUndefined();
    await deleteWorkflow(created.id);
    await expect(access(filePath)).rejects.toThrow();
    await expect(getWorkflowDocument(created.id)).rejects.toThrow("not found");
    const builtIn = registeredCodeWorkflows[0];
    expect(builtIn).toBeDefined();
    await expect(deleteWorkflow(codeWorkflowName(builtIn!))).rejects.toThrow(
      "read-only",
    );
  });
});
