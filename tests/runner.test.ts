import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import { Queue, createQueueStore } from "@/audit/queue";
import {
  formatWorkflowOutputPrompt,
  type WorkflowOutputSchemaName,
} from "@/audit/output/registry";
import { runStage, runWorkflow } from "@/audit/runner";
import { AuditSession } from "@/audit/session";
import { AuditStatus, Severity } from "@/audit/session/types";
import { WorkflowDefinition } from "@/audit/workflow";
import {
  getDefaultWorkflowId,
  getWorkflowDefinition,
} from "@/server/workflows";
import {
  auditSessionHeaderName,
  isWorkflowMcpName,
  workflowMcpServerName,
} from "@/audit/mcp/registry";
import {
  deleteSessionStateFromDb,
  readSessionStateFromDb,
} from "@/server/db/store";
import { SessionFindingStatus } from "@/server/db/schema";
import {
  createAgentMock,
  testAgent,
  testAgentLogEvents,
  testThreadResult,
} from "./mock-agent";

test("an enqueued session is consumed and completed by runWorkflow", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), "zerodrift-runner-source-"),
  );
  const workflow = await getWorkflowDefinition(await getDefaultWorkflowId());
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    projectName: "runner-test-project",
    targetPath: sourceDirectory,
    workflow,
  });

  try {
    const queue = new Queue(createQueueStore());
    queue.consume(runWorkflow);
    await queue.enqueue({ key: workflow.id, sessionId: session.sessionId });

    await vi.waitFor(
      async () => {
        expect((await readSessionStateFromDb(session.sessionId))?.status).toBe(
          AuditStatus.COMPLETED,
        );
      },
      { timeout: 5_000 },
    );

    expect(createAgentMock).toHaveBeenCalledTimes(workflow.stages.length);
    expect(createAgentMock.mock.calls.map(([agentId]) => agentId)).toEqual(
      workflow.stages.map(() => testAgent.id),
    );
    const newTurns = workflow.stages.flatMap((stage) =>
      stage.threadMode === "new" ? stage.turns.slice(0, 1) : [],
    );
    const resumedTurns = workflow.stages.flatMap((stage) =>
      stage.threadMode === "resume" ? stage.turns : stage.turns.slice(1),
    );
    expect(testAgent.newThread).toHaveBeenCalledTimes(newTurns.length);
    expect(testAgent.resumeThread).toHaveBeenCalledTimes(resumedTurns.length);
    expect(testAgent.newThread.mock.calls.map(([prompts]) => prompts)).toEqual(
      newTurns.map((turn) => [expectedTurnPrompt(turn)]),
    );
    expect(
      testAgent.resumeThread.mock.calls.map(([, prompts]) => prompts),
    ).toEqual(resumedTurns.map((turn) => [expectedTurnPrompt(turn)]));
    expect(
      testAgent.newThread.mock.calls.map(([, options]) =>
        options.mcpServers?.map(({ name }) => name),
      ),
    ).toEqual(newTurns.map(expectedMcpServerNames));
    expect(
      testAgent.resumeThread.mock.calls.map(([, , options]) =>
        options.mcpServers?.map(({ name }) => name),
      ),
    ).toEqual(resumedTurns.map(expectedMcpServerNames));
    for (const mcpServers of [
      ...testAgent.newThread.mock.calls.map(
        ([, options]) => options.mcpServers,
      ),
      ...testAgent.resumeThread.mock.calls.map(
        ([, , options]) => options.mcpServers,
      ),
    ]) {
      for (const server of mcpServers ?? []) {
        expect(server.headers).toEqual({
          [auditSessionHeaderName]: session.sessionId,
        });
      }
    }
    expect(
      await readFile(
        path.join(session.sessionDirectoryPath, "repo", "Vault.sol"),
        "utf8",
      ),
    ).toBe("contract Vault {}\n");

    const logEntries = (
      await readFile(
        path.join(session.sessionDirectoryPath, "agent.log"),
        "utf8",
      )
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(
      logEntries
        .filter((entry) => entry.agent_message !== undefined)
        .map((entry) => ({
          agent_message: entry.agent_message,
          nodeIndex: entry.nodeIndex,
          promptIndex: entry.promptIndex,
          stageIndex: entry.stageIndex,
          turnIndex: entry.turnIndex,
        })),
    ).toEqual(
      [...workflow.stages.keys()].flatMap((stageIndex) =>
        Array.from(workflow.stages[stageIndex]!.turns.keys()).flatMap(
          (turnIndex) =>
            testAgentLogEvents.map((agent_message) => ({
              agent_message,
              nodeIndex: undefined,
              promptIndex: undefined,
              stageIndex,
              turnIndex,
            })),
        ),
      ),
    );
  } finally {
    await session.close();
    await deleteSessionStateFromDb(session.sessionId);
    await rm(session.sessionDirectoryPath, { force: true, recursive: true });
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});

test("does not run a stale queue item after the session enters wait", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), "zerodrift-stale-queue-source-"),
  );
  const workflow = await getWorkflowDefinition(await getDefaultWorkflowId());
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    initialStatus: AuditStatus.WAIT,
    projectName: "stale-queue-test-project",
    targetPath: sourceDirectory,
    workflow,
  });

  try {
    await runWorkflow({
      key: workflow.id,
      sessionId: session.sessionId,
    });

    expect((await readSessionStateFromDb(session.sessionId))?.status).toBe(
      AuditStatus.WAIT,
    );
    expect(testAgent.newThread).not.toHaveBeenCalled();
  } finally {
    await session.close();
    await deleteSessionStateFromDb(session.sessionId);
    await rm(session.sessionDirectoryPath, { force: true, recursive: true });
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});

test("forks, resumes, and starts a new Workflow thread", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), "zerodrift-fork-workflow-source-"),
  );
  const workflow = Object.assign(
    new WorkflowDefinition({
      name: "Thread mode test",
      stages: [
        {
          name: "Seed",
          dependsOn: [],
          threadMode: "new",
          turns: [{ prompt: "Remember this token: 09f2a58" }],
        },
        {
          name: "Fork",
          dependsOn: ["Seed"],
          threadMode: "fork",
          turns: [
            { prompt: "Reply only with the token from the parent thread." },
          ],
        },
        {
          name: "Resume",
          dependsOn: ["Seed"],
          threadMode: "resume",
          turns: [{ prompt: "Reply only with the same token again." }],
        },
        {
          name: "New",
          dependsOn: ["Seed"],
          threadMode: "new",
          turns: [
            { prompt: "If the previous token is unknown, reply with unknown." },
          ],
        },
      ],
    }),
    { id: "thread-mode-test" },
  );
  const [seedStage, forkStage, resumeStage, newStage] = workflow.stages;
  const token = seedStage?.turns[0]?.prompt.split("token:")[1]?.trim();
  if (!token) throw new Error("Fork context test Workflow has no token.");

  expect(workflow.name).toBe("Thread mode test");
  expect(workflow.stages).toHaveLength(4);
  expect(seedStage?.turns[0]?.prompt).toContain(token);
  expect(forkStage?.threadMode).toBe("fork");
  expect(resumeStage?.threadMode).toBe("resume");
  expect(newStage?.threadMode).toBe("new");
  expect(
    [forkStage, resumeStage, newStage]
      .flatMap((stage) => stage?.turns.map((turn) => turn.prompt) ?? [])
      .join("\n"),
  ).not.toContain(token);
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    projectName: "fork-workflow-test-project",
    targetPath: sourceDirectory,
    workflow,
  });

  try {
    await runWorkflow({ key: workflow.id, sessionId: session.sessionId });

    expect(testAgent.newThread.mock.calls.map(([prompts]) => prompts)).toEqual([
      [seedStage!.turns[0]!.prompt],
      [newStage!.turns[0]!.prompt],
    ]);
    expect(
      testAgent.forkThread.mock.calls.map(
        ([sourceThreadId, lastTurnId, prompts]) => ({
          lastTurnId,
          prompts,
          sourceThreadId,
        }),
      ),
    ).toEqual([
      {
        lastTurnId: undefined,
        prompts: [forkStage!.turns[0]!.prompt],
        sourceThreadId: "test-thread-1",
      },
    ]);
    expect(
      testAgent.resumeThread.mock.calls.map(([threadId, prompts]) => ({
        prompts,
        threadId,
      })),
    ).toEqual([
      {
        prompts: [resumeStage!.turns[0]!.prompt],
        threadId: "test-thread-1",
      },
    ]);
    const state = await readSessionStateFromDb(session.sessionId);
    expect(state?.workflowState.stages.map((stage) => stage.threadId)).toEqual([
      "test-thread-1",
      "test-thread-2",
      "test-thread-1",
      "test-thread-3",
    ]);
    expect(state?.status).toBe(AuditStatus.COMPLETED);
  } finally {
    await session.close();
    await deleteSessionStateFromDb(session.sessionId);
    await rm(session.sessionDirectoryPath, { force: true, recursive: true });
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});

test("runs turn before hooks before sending review prompts", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), "zerodrift-runner-before-hook-source-"),
  );
  const workflow = Object.assign(
    new WorkflowDefinition({
      name: "Before hook test",
      stages: [
        {
          name: "Find issues",
          turns: [{ prompt: "Find issues." }],
        },
        {
          name: "Review issues",
          turns: [
            {
              beforeHooks: ["render-findings-markdown-artifact"],
              outputSchema: "finding.review",
              prompt: "Review issues.",
            },
          ],
        },
      ],
    }),
    { id: "before-hook-test" },
  );
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    projectName: "runner-before-hook-test-project",
    targetPath: sourceDirectory,
    workflow,
  });
  const findingsMarkdown = path.join(
    session.sessionDirectoryPath,
    "finding.md",
  );
  const reviewPromptMarkdown: string[] = [];
  let stageRunCount = 0;
  let activeStageRunIndex = -1;
  const runPrompts = async (
    prompts: readonly string[],
    options: Parameters<typeof testAgent.newThread>[1],
  ) => {
    for (const [promptIndex] of prompts.entries()) {
      await options.beforePrompt?.(promptIndex);
      if (activeStageRunIndex === 0 && promptIndex === 0) {
        await session.addFinding({
          description: "Anyone can withdraw funds without authorization.",
          file_path: "Vault.sol",
          impact: "Funds can be stolen.",
          root_cause: "The withdraw function has no access control.",
          severity: Severity.HIGH,
          title: "Unauthorized withdrawal",
        });
      }
      if (activeStageRunIndex === 1) {
        reviewPromptMarkdown.push(await readFile(findingsMarkdown, "utf8"));
      }
    }
  };
  testAgent.newThread.mockImplementation(async (prompts, options) => {
    activeStageRunIndex = stageRunCount++;
    const threadId = `before-hook-thread-${stageRunCount}`;
    await options.onThreadEvent?.({ type: "thread", threadId });
    await runPrompts(prompts, options);
    return testThreadResult(threadId, prompts, options);
  });
  testAgent.resumeThread.mockImplementation(
    async (threadId, prompts, options) => {
      await options.onThreadEvent?.({ type: "thread", threadId });
      await runPrompts(prompts, options);
      return testThreadResult(threadId, prompts, options);
    },
  );

  try {
    await runWorkflow({ key: workflow.id, sessionId: session.sessionId });

    expect(stageRunCount).toBe(workflow.stages.length);
    expect(reviewPromptMarkdown).toHaveLength(workflow.stages[1]!.turns.length);
    expect(reviewPromptMarkdown).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Unauthorized withdrawal"),
      ]),
    );
  } finally {
    await session.close();
    await deleteSessionStateFromDb(session.sessionId);
    await rm(session.sessionDirectoryPath, { force: true, recursive: true });
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});

test("runs turn after hooks after the agent completes", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), "zerodrift-runner-after-hook-source-"),
  );
  const workflow = Object.assign(
    new WorkflowDefinition({
      name: "After hook test",
      stages: [
        {
          name: "Submit finding",
          turns: [
            {
              prompt: "submit a finding",
              goal: true,
              afterHooks: ["render-findings-markdown-artifact"],
            },
          ],
        },
      ],
    }),
    { id: "after-hook-test" },
  );
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const session = await AuditSession.createAuditSession({
    agents: [testAgent],
    projectName: "runner-after-hook-test-project",
    targetPath: sourceDirectory,
    workflow,
  });

  testAgent.newThread.mockImplementation(async (prompts, options) => {
    void prompts;
    const threadId = "after-hook-thread";
    await options.onThreadEvent?.({ type: "thread", threadId });
    await options.beforePrompt?.(0);
    await session.addFinding({
      description: "Anyone can withdraw funds without authorization.",
      file_path: "Vault.sol",
      impact: "Funds can be stolen.",
      root_cause: "The withdraw function has no access control.",
      severity: Severity.HIGH,
      title: "Unauthorized withdrawal",
    });
    return testThreadResult(threadId, prompts, options);
  });

  try {
    await runWorkflow({ key: workflow.id, sessionId: session.sessionId });

    expect(
      await readFile(
        path.join(session.sessionDirectoryPath, "finding.md"),
        "utf8",
      ),
    ).toContain("Unauthorized withdrawal");
    expect(testAgent.newThread.mock.calls[0]?.[1].goal).toBe(true);
  } finally {
    await session.close();
    await deleteSessionStateFromDb(session.sessionId);
    await rm(session.sessionDirectoryPath, { force: true, recursive: true });
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});

function expectedMcpServerNames(turn: { mcp?: readonly string[] }) {
  return [...new Set((turn.mcp ?? []).filter(isWorkflowMcpName))].map(
    workflowMcpServerName,
  );
}

function expectedTurnPrompt(
  turn: WorkflowDefinition["stages"][number]["turns"][number],
) {
  return turn.outputSchema
    ? formatWorkflowOutputPrompt(turn.prompt, turn.outputSchema)
    : turn.prompt;
}

test("manually runs and reruns a Stage through the mock BaseAgent thread API", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), "zerodrift-manual-stage-source-"),
  );
  const workflow = Object.assign(
    new WorkflowDefinition({
      name: "Manual Stage test",
      stages: [
        {
          name: "Generate artifacts",
          turns: [
            {
              prompt: "stage 0 turn 0",
            },
            {
              prompt: "stage 0 turn 1",
            },
          ],
        },
        {
          name: "Consume artifacts",
          turns: [
            {
              prompt: "stage 1 turn 0",
            },
          ],
        },
      ],
    }),
    { id: "manual-stage-test" },
  );
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    initialStatus: AuditStatus.WAIT,
    projectName: "manual-stage-test-project",
    targetPath: sourceDirectory,
    workflow,
  });
  let threadSequence = 0;

  testAgent.newThread.mockImplementation(async (prompts, options) => {
    const threadId = `mock-thread-${++threadSequence}`;
    await options.onThreadEvent?.({ type: "thread", threadId });
    await options.beforePrompt?.(0);
    if (prompts[0] === "stage 0 turn 0") {
      const outputPath = path.join(options.cwd, "stage-0", "turn-0.txt");
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, threadId, "utf8");
    } else if (prompts[0] === "stage 1 turn 0") {
      const outputPath = path.join(options.cwd, "stage-1", "result.txt");
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, threadId, "utf8");
    }
    return testThreadResult(threadId, prompts, options);
  });
  testAgent.resumeThread.mockImplementation(
    async (threadId, prompts, options) => {
      await options.onThreadEvent?.({ type: "thread", threadId });
      await options.beforePrompt?.(0);
      if (prompts[0] === "stage 0 turn 1") {
        await writeFile(
          path.join(options.cwd, "stage-0", "turn-1.txt"),
          threadId,
          "utf8",
        );
      }
      return testThreadResult(threadId, prompts, options);
    },
  );

  try {
    const firstStageRun = await runStage({
      sessionId: session.sessionId,
      stageIndex: 0,
    });
    expect(firstStageRun.attempt).toBe(1);
    expect(firstStageRun.status).toBe(AuditStatus.WAIT);
    expect(firstStageRun.workflowState.stages[0]?.threadId).toBe(
      "mock-thread-1",
    );

    const downstreamRun = await runStage({
      sessionId: session.sessionId,
      stageIndex: 1,
    });
    expect(downstreamRun.status).toBe(AuditStatus.COMPLETED);
    expect(
      await readFile(
        path.join(session.repoDirectoryPath, "stage-1", "result.txt"),
        "utf8",
      ),
    ).toBe("mock-thread-2");

    const repeatedStageRun = await runStage({
      sessionId: session.sessionId,
      stageIndex: 0,
    });
    expect(repeatedStageRun.attempt).toBe(2);
    expect(repeatedStageRun.status).toBe(AuditStatus.WAIT);
    expect(repeatedStageRun.workflowState.stages[0]).toMatchObject({
      attempt: 2,
      status: "completed",
      threadId: "mock-thread-3",
      turns: [
        { runCount: 2, status: "completed" },
        { runCount: 2, status: "completed" },
      ],
    });
    expect(repeatedStageRun.workflowState.stages[1]).toMatchObject({
      attempt: 1,
      status: "pending",
      turns: [{ runCount: 1, status: "pending" }],
    });
    expect(repeatedStageRun.workflowState.stages[1]?.threadId).toBeUndefined();
    expect(
      await readFile(
        path.join(session.repoDirectoryPath, "stage-1", "result.txt"),
        "utf8",
      ),
    ).toBe("mock-thread-2");

    expect(testAgent.newThread.mock.calls.map(([prompts]) => prompts)).toEqual([
      ["stage 0 turn 0"],
      ["stage 1 turn 0"],
      ["stage 0 turn 0"],
    ]);
    expect(
      testAgent.resumeThread.mock.calls.map(([threadId, prompts]) => ({
        prompts,
        threadId,
      })),
    ).toEqual([
      { prompts: ["stage 0 turn 1"], threadId: "mock-thread-1" },
      { prompts: ["stage 0 turn 1"], threadId: "mock-thread-3" },
    ]);

    const persisted = await readSessionStateFromDb(session.sessionId);
    expect(persisted?.status).toBe(AuditStatus.WAIT);
    expect(persisted?.workflowState).toEqual(repeatedStageRun.workflowState);
  } finally {
    await session.close();
    await deleteSessionStateFromDb(session.sessionId);
    await rm(session.sessionDirectoryPath, { force: true, recursive: true });
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});

test("applies partial structured finding output during a full Workflow run", async () => {
  const fixture = await createStructuredOutputFixture({
    label: "full",
    outputSchema: "finding.submit",
  });
  const validFinding = runnerFinding("Full-run finding");
  testAgent.newThread.mockImplementation(async (prompts, options) => {
    await options.onThreadEvent?.({ type: "thread", threadId: "full-output" });
    await options.beforePrompt?.(0);
    return testThreadResult("full-output", prompts, options, [
      validFinding,
      { ...runnerFinding("Generated file"), file_path: "Generated.sol" },
    ]);
  });

  try {
    await runWorkflow({
      key: fixture.workflow.id,
      sessionId: fixture.session.sessionId,
    });

    expect(
      (await fixture.session.readAllFindings()).map(({ title }) => title),
    ).toEqual(["Full-run finding"]);
    expect(
      (await readSessionStateFromDb(fixture.session.sessionId))?.status,
    ).toBe(AuditStatus.COMPLETED);
    expect(testAgent.newThread.mock.calls[0]?.[0][0]).toContain(
      "only the raw JSON array",
    );
    expect(testAgent.newThread.mock.calls[0]?.[1].outputSchema).toMatchObject({
      type: "array",
    });
  } finally {
    await cleanupStructuredOutputFixture(fixture);
  }
});

test("collects every formatted finding output through a full mock Agent Workflow", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), "zerodrift-runner-finding-lifecycle-"),
  );
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const workflow = Object.assign(
    new WorkflowDefinition({
      name: "Mock Finding Output lifecycle",
      stages: [
        {
          name: "Finding Output lifecycle",
          turns: [
            {
              outputSchema: "finding.submit",
              prompt: "Return the five mock candidate findings.",
            },
            {
              outputSchema: "finding.submit-confirmed",
              prompt: "Return Mock Direct Confirmed Finding.",
            },
            {
              beforeHooks: ["render-findings-markdown-artifact"],
              outputSchema: "finding.duplicate",
              prompt: "Return the duplicate mapping.",
            },
            {
              beforeHooks: ["render-findings-markdown-artifact"],
              outputSchema: "finding.review",
              prompt: "Return the review results.",
            },
            {
              beforeHooks: ["render-findings-markdown-artifact"],
              outputSchema: "finding.onchain-confirm",
              prompt: "Return the on-chain confirmation.",
            },
          ],
        },
      ],
    }),
    { id: "mock-finding-output-lifecycle" },
  );
  const stage = workflow.stages[0];
  if (!stage) throw new Error("Expected the Finding Output test Stage.");
  const session = await AuditSession.createAuditSession({
    agents: [testAgent],
    projectName: "finding-output-lifecycle-test",
    targetPath: sourceDirectory,
    workflow,
  });
  const formattedOutputs: WorkflowOutputSchemaName[] = [];

  testAgent.setStructuredOutputFormatter(async (prompts, options) => {
    const prompt = prompts.at(-1) ?? "";
    expect(options.outputSchema).toMatchObject({ type: "array" });

    if (prompt.includes("five mock candidate findings")) {
      formattedOutputs.push("finding.submit");
      return [
        "Mock Canonical Finding",
        "Mock Duplicate Finding",
        "Mock Review Confirm Finding",
        "Mock Review Reject Finding",
        "Mock On-chain Finding",
      ].map((title) => ({
        ...runnerFinding(title),
        recommendation: `${title} mock recommendation`,
      }));
    }

    if (prompt.includes("Mock Direct Confirmed Finding")) {
      formattedOutputs.push("finding.submit-confirmed");
      return [
        {
          ...runnerFinding("Mock Direct Confirmed Finding"),
          recommendation: "Mock Direct Confirmed Finding recommendation",
        },
      ];
    }

    const findingsMarkdown = await readFile(
      path.join(options.cwd, "..", "finding.md"),
      "utf8",
    );
    const findingId = (title: string) =>
      findingIdFromMarkdown(findingsMarkdown, title);

    if (prompt.includes("duplicate mapping")) {
      formattedOutputs.push("finding.duplicate");
      return [
        {
          duplicate_of_id: findingId("Mock Canonical Finding"),
          finding_id: findingId("Mock Duplicate Finding"),
        },
      ];
    }

    if (prompt.includes("review results")) {
      formattedOutputs.push("finding.review");
      return [
        {
          decision: "confirm",
          finding_id: findingId("Mock Canonical Finding"),
          reason: "Mock canonical confirmation reason.",
        },
        {
          decision: "confirm",
          finding_id: findingId("Mock Review Confirm Finding"),
          reason: "Mock review confirmation reason.",
        },
        {
          decision: "reject",
          finding_id: findingId("Mock Review Reject Finding"),
          reason: "Mock review rejection reason.",
        },
      ];
    }

    if (prompt.includes("on-chain confirmation")) {
      formattedOutputs.push("finding.onchain-confirm");
      return [
        {
          economic_impact: "Mock economic impact.",
          finding_id: findingId("Mock On-chain Finding"),
          trigger_conditions: "Mock trigger conditions.",
          triggered_actor: "Mock unprivileged actor.",
        },
      ];
    }

    throw new Error(`Unexpected Finding Output test prompt: ${prompt}`);
  });

  try {
    expect(stage.turns.map((turn) => turn.outputSchema)).toEqual([
      "finding.submit",
      "finding.submit-confirmed",
      "finding.duplicate",
      "finding.review",
      "finding.onchain-confirm",
    ]);

    await runWorkflow({ key: workflow.id, sessionId: session.sessionId });

    const findings = await session.readAllFindings();
    expect(findings).toHaveLength(6);
    const byTitle = new Map(
      findings.map((finding) => [finding.title, finding]),
    );
    const canonical = byTitle.get("Mock Canonical Finding");
    if (!canonical) throw new Error("Expected the canonical mock finding.");

    expect(Object.fromEntries(byTitle)).toMatchObject({
      "Mock Canonical Finding": {
        confirmation_reason: "Mock canonical confirmation reason.",
        status: SessionFindingStatus.CONFIRMED,
      },
      "Mock Direct Confirmed Finding": {
        status: SessionFindingStatus.CONFIRMED,
      },
      "Mock Duplicate Finding": {
        duplicate_of_id: canonical.id,
        status: SessionFindingStatus.DUPLICATE,
      },
      "Mock On-chain Finding": {
        economic_impact: "Mock economic impact.",
        status: SessionFindingStatus.ONCHAIN_CONFIRMED,
        trigger_conditions: "Mock trigger conditions.",
        triggered_actor: "Mock unprivileged actor.",
      },
      "Mock Review Confirm Finding": {
        confirmation_reason: "Mock review confirmation reason.",
        status: SessionFindingStatus.CONFIRMED,
      },
      "Mock Review Reject Finding": {
        rejection_reason: "Mock review rejection reason.",
        status: SessionFindingStatus.REJECTED,
      },
    });
    expect(formattedOutputs).toEqual([
      "finding.submit",
      "finding.submit-confirmed",
      "finding.duplicate",
      "finding.review",
      "finding.onchain-confirm",
    ]);
    expect(testAgent.newThread).toHaveBeenCalledTimes(1);
    expect(testAgent.resumeThread).toHaveBeenCalledTimes(4);
    expect(
      (
        await readSessionStateFromDb(session.sessionId)
      )?.workflowState.stages[0]?.turns.map((turn) => turn.status),
    ).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect((await readSessionStateFromDb(session.sessionId))?.status).toBe(
      AuditStatus.COMPLETED,
    );
  } finally {
    await session.close();
    await deleteSessionStateFromDb(session.sessionId);
    await rm(session.sessionDirectoryPath, { force: true, recursive: true });
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});

test("applies structured finding output during a manual Stage run", async () => {
  const fixture = await createStructuredOutputFixture({
    initialStatus: AuditStatus.WAIT,
    label: "manual",
    outputSchema: "finding.submit-confirmed",
  });
  testAgent.newThread.mockImplementation(async (prompts, options) => {
    await options.onThreadEvent?.({
      type: "thread",
      threadId: "manual-output",
    });
    await options.beforePrompt?.(0);
    return testThreadResult("manual-output", prompts, options, [
      runnerFinding("Manual finding"),
    ]);
  });

  try {
    await expect(
      runStage({ sessionId: fixture.session.sessionId, stageIndex: 0 }),
    ).resolves.toMatchObject({ status: AuditStatus.COMPLETED });
    expect(await fixture.session.readAllFindings()).toMatchObject([
      {
        status: SessionFindingStatus.CONFIRMED,
        title: "Manual finding",
      },
    ]);
  } finally {
    await cleanupStructuredOutputFixture(fixture);
  }
});

test("fails the active turn when every structured output item is rejected", async () => {
  const fixture = await createStructuredOutputFixture({
    label: "invalid",
    outputSchema: "finding.submit",
  });
  testAgent.newThread.mockImplementation(async (prompts, options) => {
    await options.onThreadEvent?.({
      type: "thread",
      threadId: "invalid-output",
    });
    await options.beforePrompt?.(0);
    return testThreadResult("invalid-output", prompts, options, [
      { title: "Missing fields" },
    ]);
  });

  try {
    await expect(
      runWorkflow({
        key: fixture.workflow.id,
        sessionId: fixture.session.sessionId,
      }),
    ).rejects.toThrow("applied no items");
    const state = await readSessionStateFromDb(fixture.session.sessionId);
    expect(state?.status).toBe(AuditStatus.FAILED);
    expect(state?.workflowState.stages[0]?.turns[0]?.status).toBe("failed");
    expect(await fixture.session.readAllFindings()).toEqual([]);
  } finally {
    await cleanupStructuredOutputFixture(fixture);
  }
});

async function createStructuredOutputFixture({
  initialStatus,
  label,
  outputSchema,
}: {
  initialStatus?: AuditStatus;
  label: string;
  outputSchema: WorkflowOutputSchemaName;
}) {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), `zerodrift-runner-output-${label}-`),
  );
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const workflow = Object.assign(
    new WorkflowDefinition({
      name: `Structured output ${label}`,
      stages: [
        {
          name: "Finding output",
          turns: [
            {
              outputSchema,
              prompt: "Return findings.",
            },
          ],
        },
      ],
    }),
    { id: `structured-output-${label}` },
  );
  const session = await AuditSession.createAuditSession({
    agents: [testAgent],
    ...(initialStatus ? { initialStatus } : {}),
    projectName: `structured-output-${label}`,
    targetPath: sourceDirectory,
    workflow,
  });
  return { session, sourceDirectory, workflow };
}

function runnerFinding(title: string) {
  return {
    description: `${title} description`,
    file_path: "Vault.sol",
    impact: `${title} impact`,
    root_cause: `${title} root cause`,
    severity: Severity.HIGH,
    title,
  };
}

function findingIdFromMarkdown(markdown: string, title: string) {
  const heading = markdown
    .split("\n")
    .find((line) => line.startsWith("## ") && line.endsWith(`. ${title}`));
  if (!heading) {
    throw new Error(`Finding ID not found in finding.md: ${title}`);
  }
  const id = Number(heading.slice(3, heading.indexOf(".")));
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Finding ID not found in finding.md: ${title}`);
  }
  return id;
}

async function cleanupStructuredOutputFixture(
  fixture: Awaited<ReturnType<typeof createStructuredOutputFixture>>,
) {
  await fixture.session.close();
  await deleteSessionStateFromDb(fixture.session.sessionId);
  await rm(fixture.session.sessionDirectoryPath, {
    force: true,
    recursive: true,
  });
  await rm(fixture.sourceDirectory, { force: true, recursive: true });
}
