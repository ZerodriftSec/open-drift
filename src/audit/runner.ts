import { lstat } from "node:fs/promises";
import type { QueueConsumerControl, QueueItem } from "@/audit/queue";
import type {
  AgentThreadResult,
  BaseAgent,
  ThreadOptions,
} from "@/audit/agent/base-agent";
import { AuditSession } from "@/audit/session";
import {
  AuditStatus,
  type AuditStatus as AuditStatusValue,
} from "@/audit/session/types";
import {
  isWorkflowMcpName,
  resolveWorkflowMcpServers,
  type WorkflowMcpName,
} from "@/audit/mcp/registry";
import {
  applyWorkflowOutput,
  formatWorkflowOutputPrompt,
  getWorkflowOutputDefinition,
} from "@/audit/output/registry";
import type { WorkflowOutputSchemaName } from "@/audit/output/names";
import { runWorkflowHooks } from "@/audit/workflow/hook-registry";
import type { WorkflowSkillSelection } from "@/audit/workflow";
import type { WorkflowStateSnapshot } from "@/audit/workflow/status";
import {
  isAppRuntimeShuttingDown,
  trackAppSessionTurnAbortController,
} from "@/server/runtime/cleanup";

export async function runWorkflow(
  item: QueueItem,
  queueControl?: QueueConsumerControl,
): Promise<void> {
  let session: AuditSession | undefined;
  let activeStageIndex: number | undefined;
  let activeTurnIndex: number | undefined;
  let activeAgent: BaseAgent | undefined;
  let activeThreadId: string | undefined;
  let activeTurnId: string | undefined;
  let turnRuntime:
    Awaited<ReturnType<typeof trackAppSessionTurnAbortController>> | undefined;
  let abortActiveTurn: (() => void) | undefined;

  try {
    const restoredSession = await AuditSession.restore(item.sessionId);
    session = restoredSession;
    const started = await restoredSession.claimQueuedExecution();
    if (!started) {
      return;
    }
    await queueControl?.markStarted();
    await restoredSession.workflowState.beginFullWorkflowExecution();
    turnRuntime = await trackAppSessionTurnAbortController(restoredSession);
    abortActiveTurn = () => {
      if (!activeAgent || !activeThreadId || !activeTurnId) return;
      void activeAgent.abort(activeThreadId, activeTurnId).catch((error) => {
        restoredSession.agentLogger.error({ err: error }, "agent_abort_failed");
      });
    };
    turnRuntime.signal.addEventListener("abort", abortActiveTurn);

    const workflow = restoredSession.workflow;
    if (restoredSession.agents.length !== workflow.stages.length) {
      throw new Error(
        "Workflow execution requires one Agent for each Workflow Stage.",
      );
    }

    await restoredSession.copySourceToWorkingDirectory();
    await restoredSession.writeOnchainInfoToSessionDirectory();

    for (const [stageIndex, stage] of workflow.stages.entries()) {
      turnRuntime.signal.throwIfAborted();
      activeStageIndex = stageIndex;
      activeTurnIndex = undefined;
      activeThreadId = undefined;
      activeTurnId = undefined;
      await restoredSession.workflowState.beginStageAttempt(stageIndex);
      const agent = restoredSession.agents[stageIndex];
      if (!agent) {
        throw new Error(
          `Workflow stage ${stage.name ?? stageIndex + 1} has no assigned Agent.`,
        );
      }
      activeAgent = agent;
      const skills = stageSkills(stage.turns);
      await agent.copySkillsToWorkingDirectory(
        restoredSession.repoDirectoryPath,
        skills,
      );
      for (const [turnIndex, turn] of stage.turns.entries()) {
        turnRuntime.signal.throwIfAborted();
        activeTurnIndex = turnIndex;
        await restoredSession.workflowState.markTurnRunning(
          stageIndex,
          turnIndex,
        );
        const outputDefinition = prepareWorkflowOutput(
          agent,
          turn.outputSchema,
        );
        const mcpServers = await resolveWorkflowMcpServers({
          mcp: turnMcps(turn),
          sessionId: restoredSession.sessionId,
        });
        const options: ThreadOptions = {
          beforePrompt: async () => {
            await runWorkflowHooks(turn.beforeHooks ?? [], restoredSession);
          },
          cwd: restoredSession.repoDirectoryPath,
          goal: turn.goal === true,
          mcpServers,
          onThreadEvent: async (event) => {
            if (event.type === "thread") {
              activeThreadId = event.threadId;
              activeTurnId = undefined;
              await restoredSession.workflowState.setStageThreadId(
                stageIndex,
                event.threadId,
              );
              return;
            }

            activeThreadId = event.threadId;
            activeTurnId = event.turnId;
            if (turnRuntime?.signal.aborted) {
              await agent.abort(event.threadId, event.turnId);
            }
          },
          ...(outputDefinition
            ? { outputSchema: outputDefinition.jsonSchema }
            : {}),
          skills,
          webSearch: "live",
        };
        const logger = restoredSession.agentLogger.child({
          stageIndex,
          turnIndex,
        });

        const result: AgentThreadResult =
          turnIndex === 0
            ? await startStageThread({
                agent,
                logger,
                options,
                prompt: outputPrompt(turn.prompt, turn.outputSchema),
                session: restoredSession,
                stageIndex,
              })
            : await agent.resumeThread(
                requiredThreadId(activeThreadId, stageIndex),
                [outputPrompt(turn.prompt, turn.outputSchema)],
                options,
                logger,
              );
        activeThreadId = result.threadId;

        turnRuntime.signal.throwIfAborted();
        if (turn.outputSchema) {
          await applyWorkflowOutput({
            logger,
            name: turn.outputSchema,
            output: finalStructuredOutput(result),
            session: restoredSession,
          });
        }
        await runWorkflowHooks(turn.afterHooks ?? [], restoredSession);
        await restoredSession.workflowState.markTurnCompleted(
          stageIndex,
          turnIndex,
        );
        activeTurnIndex = undefined;
      }
      await restoredSession.workflowState.markStageCompleted(stageIndex);
      activeStageIndex = undefined;
      activeAgent = undefined;
      activeThreadId = undefined;
      activeTurnId = undefined;
    }

    await restoredSession.workflowState.completeWorkflowExecution();
    await restoredSession.setStatus(AuditStatus.COMPLETED);
  } catch (error) {
    if (session && !isAppRuntimeShuttingDown()) {
      session.agentLogger.error({ err: error }, "workflow_failed");
      if (activeStageIndex !== undefined) {
        if (activeTurnIndex !== undefined) {
          await session.workflowState
            .markTurnFailed(activeStageIndex, activeTurnIndex, error)
            .catch(() => undefined);
        } else {
          await session.workflowState
            .markStageFailed(activeStageIndex, error)
            .catch(() => undefined);
        }
      }
      await session.workflowState
        .failWorkflowExecution(error)
        .catch(() => undefined);
      await session
        .setStatus(
          turnRuntime?.signal.aborted
            ? AuditStatus.INTERRUPTED
            : AuditStatus.FAILED,
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    if (turnRuntime && abortActiveTurn) {
      turnRuntime.signal.removeEventListener("abort", abortActiveTurn);
    }
    turnRuntime?.untrack();
    await session?.close();
  }
}

export type RunStageResult = {
  attempt: number;
  sessionId: string;
  stageIndex: number;
  status: AuditStatusValue;
  workflowState: WorkflowStateSnapshot;
};

export class RunStageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "RunStageError";
  }
}

export async function runStage({
  sessionId,
  stageIndex,
}: {
  sessionId: string;
  stageIndex: number;
}): Promise<RunStageResult> {
  let session: AuditSession | undefined;
  let activeTurnIndex: number | undefined;
  let executionClaimed = false;
  let turnRuntime:
    Awaited<ReturnType<typeof trackAppSessionTurnAbortController>> | undefined;
  let abortActiveTurn: (() => void) | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;

  try {
    try {
      session = await AuditSession.restore(sessionId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `AuditSession not found: ${sessionId}`
      ) {
        throw new RunStageError(`Session not found: ${sessionId}`, 404);
      }
      throw error;
    }

    const stage = session.workflow.stages[stageIndex];
    if (!stage) {
      throw new RunStageError(
        `Stage ${stageIndex} does not exist in the Workflow.`,
        400,
      );
    }
    if (stage.turns.length === 0) {
      throw new RunStageError(`Stage ${stageIndex} has no runnable Turn.`, 400);
    }

    const agent = session.agents[stageIndex];
    if (!agent) {
      throw new RunStageError(
        `Stage ${stageIndex} has no assigned Agent.`,
        400,
      );
    }

    executionClaimed = await session.claimExecution();
    if (!executionClaimed) {
      throw new RunStageError(
        `Session ${sessionId} is already queued or running.`,
        409,
      );
    }

    turnRuntime = await trackAppSessionTurnAbortController(session);
    abortActiveTurn = () => {
      if (!threadId || !turnId) return;
      void agent.abort(threadId, turnId).catch((error) => {
        session?.agentLogger.error({ err: error }, "agent_abort_failed");
      });
    };
    turnRuntime.signal.addEventListener("abort", abortActiveTurn);
    await ensureWorkingDirectory(session);

    activeTurnIndex = 0;
    await session.workflowState.beginManualTurnExecution(stageIndex, 0);

    const skills = stageSkills(stage.turns);
    await agent.copySkillsToWorkingDirectory(session.repoDirectoryPath, skills);

    for (const [turnIndex, turn] of stage.turns.entries()) {
      turnRuntime.signal.throwIfAborted();
      activeTurnIndex = turnIndex;
      if (turnIndex > 0) {
        await session.workflowState.beginManualTurnExecution(
          stageIndex,
          turnIndex,
        );
      }

      const outputDefinition = prepareWorkflowOutput(agent, turn.outputSchema);
      const mcpServers = await resolveWorkflowMcpServers({
        mcp: turnMcps(turn),
        sessionId: session.sessionId,
      });
      const hookSession = session;
      const options: ThreadOptions = {
        beforePrompt: async () => {
          await runWorkflowHooks(turn.beforeHooks ?? [], hookSession);
        },
        cwd: session.repoDirectoryPath,
        goal: turn.goal === true,
        mcpServers,
        onThreadEvent: async (event) => {
          if (event.type === "thread") {
            threadId = event.threadId;
            turnId = undefined;
            await session?.workflowState.setStageThreadId(
              stageIndex,
              event.threadId,
            );
            return;
          }

          threadId = event.threadId;
          turnId = event.turnId;
          if (turnRuntime?.signal.aborted) {
            await agent.abort(event.threadId, event.turnId);
          }
        },
        ...(outputDefinition
          ? { outputSchema: outputDefinition.jsonSchema }
          : {}),
        skills,
        webSearch: "live",
      };
      const logger = session.agentLogger.child({
        stageIndex,
        turnIndex,
      });

      const result: AgentThreadResult =
        turnIndex === 0
          ? await startStageThread({
              agent,
              logger,
              options,
              prompt: outputPrompt(turn.prompt, turn.outputSchema),
              session,
              stageIndex,
            })
          : await agent.resumeThread(
              requiredThreadId(threadId, stageIndex),
              [outputPrompt(turn.prompt, turn.outputSchema)],
              options,
              logger,
            );
      threadId = result.threadId;
      turnRuntime.signal.throwIfAborted();
      if (turn.outputSchema) {
        await applyWorkflowOutput({
          logger,
          name: turn.outputSchema,
          output: finalStructuredOutput(result),
          session,
        });
      }
      await runWorkflowHooks(turn.afterHooks ?? [], hookSession);

      await session.workflowState.markTurnCompleted(stageIndex, turnIndex);
      activeTurnIndex = undefined;
    }

    await session.workflowState.markStageCompleted(stageIndex);
    const workflowState = session.workflowState.toJSON();
    const status =
      workflowState.status === "completed"
        ? AuditStatus.COMPLETED
        : AuditStatus.WAIT;
    await session.setStatus(status);
    const stageState = workflowState.stages.find(
      (candidate) => candidate.stageIndex === stageIndex,
    );
    if (!stageState) {
      throw new Error(`Workflow state is missing Stage ${stageIndex}.`);
    }

    return {
      attempt: stageState.attempt,
      sessionId,
      stageIndex,
      status,
      workflowState,
    };
  } catch (error) {
    if (session && executionClaimed && !isAppRuntimeShuttingDown()) {
      session.agentLogger.error(
        { err: error, stageIndex },
        "manual_stage_failed",
      );
      if (activeTurnIndex !== undefined) {
        await session.workflowState
          .markTurnFailed(stageIndex, activeTurnIndex, error)
          .catch(() => undefined);
      } else {
        await session.workflowState
          .markStageFailed(stageIndex, error)
          .catch(() => undefined);
      }
      await session
        .setStatus(
          turnRuntime?.signal.aborted
            ? AuditStatus.INTERRUPTED
            : AuditStatus.FAILED,
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    if (turnRuntime && abortActiveTurn) {
      turnRuntime.signal.removeEventListener("abort", abortActiveTurn);
    }
    turnRuntime?.untrack();
    await session?.close();
  }
}

async function ensureWorkingDirectory(session: AuditSession) {
  const stat = await lstat(session.repoDirectoryPath).catch(() => undefined);
  if (stat) {
    if (!stat.isDirectory()) {
      throw new RunStageError(
        `Session working path is not a directory: ${session.repoDirectoryPath}`,
        400,
      );
    }
    return;
  }

  await session.copySourceToWorkingDirectory();
  await session.writeOnchainInfoToSessionDirectory();
}

function requiredThreadId(threadId: string | undefined, stageIndex: number) {
  if (!threadId) {
    throw new Error(`Stage ${stageIndex} has no resumable Codex Thread.`);
  }
  return threadId;
}

async function startStageThread({
  agent,
  logger,
  options,
  prompt,
  session,
  stageIndex,
}: {
  agent: BaseAgent;
  logger: Parameters<BaseAgent["newThread"]>[2];
  options: ThreadOptions;
  prompt: string;
  session: AuditSession;
  stageIndex: number;
}) {
  const stage = session.workflow.stages[stageIndex];
  if (!stage || stage.threadMode === undefined || stage.threadMode === "new") {
    return agent.newThread([prompt], options, logger);
  }

  const parentName = stage.dependsOn?.[0];
  const parentIndex = session.workflow.stages.findIndex(
    (candidate) => candidate.name === parentName,
  );
  const parentState = session.workflowState
    .toJSON()
    .stages.find((candidate) => candidate.stageIndex === parentIndex);
  const mode = stage.threadMode === "fork" ? "Fork" : "Resume";
  if (parentIndex < 0 || parentState?.status !== "completed") {
    throw new Error(
      `${mode} Workflow Stage ${stage.name} requires completed parent ${parentName}.`,
    );
  }
  if (!parentState.threadId) {
    throw new Error(
      `${mode} Workflow Stage ${stage.name} parent ${parentName} has no thread.`,
    );
  }

  if (stage.threadMode === "resume") {
    return agent.resumeThread(parentState.threadId, [prompt], options, logger);
  }

  return agent.forkThread(
    parentState.threadId,
    undefined,
    [prompt],
    options,
    logger,
  );
}

function turnMcps(turn: { mcp?: readonly string[] }): WorkflowMcpName[] {
  return [...new Set((turn.mcp ?? []).filter(isWorkflowMcpName))];
}

function prepareWorkflowOutput(
  agent: BaseAgent,
  name: WorkflowOutputSchemaName | undefined,
) {
  if (!name) return undefined;
  if (!agent.supportsOutputSchema) {
    throw new Error(
      `Agent ${agent.id} does not support workflow outputSchema ${name}.`,
    );
  }
  return getWorkflowOutputDefinition(name);
}

function outputPrompt(
  prompt: string,
  outputSchema: WorkflowOutputSchemaName | undefined,
) {
  return outputSchema
    ? formatWorkflowOutputPrompt(prompt, outputSchema)
    : prompt;
}

function finalStructuredOutput(result: AgentThreadResult) {
  return result.turns[result.turns.length - 1]?.structuredOutput;
}

function stageSkills(
  turns: readonly { skills?: WorkflowSkillSelection }[],
): WorkflowSkillSelection | undefined {
  const names = new Set<string>();
  const prefixes = new Set<string>();
  for (const turn of turns) {
    turn.skills?.names?.forEach((name) => names.add(name));
    turn.skills?.prefixes?.forEach((prefix) => prefixes.add(prefix));
  }
  return names.size || prefixes.size
    ? { names: [...names], prefixes: [...prefixes] }
    : undefined;
}
