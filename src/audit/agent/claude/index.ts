import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import {
  BaseAgent,
  toJsonValue,
  type AgentThreadResult,
  type ThreadOptions,
} from "@/audit/agent/base-agent";
import { copyAuditSkills } from "@/audit/agent/skills";
import {
  AgentProvider,
  ModelProvider,
  type AgentMessage,
  type AgentTurnStatus,
  type ClaudeAgentDefinition,
} from "@/audit/agent/types";
import type { WorkflowSkillSelection } from "@/audit/workflow";

export enum ClaudeReasoningEffort {
  LOW = "low",
  MAX = "max",
}

export enum ClaudeModel {
  DEEPSEEK_V4_FLASH = "deepseek-v4-flash",
  DEEPSEEK_V4_PRO = "deepseek-v4-pro",
  GLM_4_5_AIR = "glm-4.7",
  GLM_5_3 = "glm-5.3",
}

export enum ClaudeApi {
  DEEPSEEK = "deepseek",
  GLM = "glm",
}

type ClaudeApiConfig = {
  apiBaseUrlEnv: string;
  apiKeyEnv: string;
};

export const claudeApis = {
  [ClaudeApi.DEEPSEEK]: {
    apiBaseUrlEnv: "DEEPSEEK_API_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  [ClaudeApi.GLM]: {
    apiBaseUrlEnv: "GLM_API_BASE_URL",
    apiKeyEnv: "GLM_API_KEY",
  },
} as const satisfies Record<ClaudeApi, ClaudeApiConfig>;

export const claudeModels = {
  [ClaudeModel.DEEPSEEK_V4_FLASH]: {
    displayName: "DeepSeek V4 Flash",
  },
  [ClaudeModel.DEEPSEEK_V4_PRO]: {
    displayName: "DeepSeek V4 Pro",
  },
  [ClaudeModel.GLM_4_5_AIR]: {
    displayName: "GLM-4.7",
  },
  [ClaudeModel.GLM_5_3]: {
    displayName: "GLM-5.3",
  },
} as const satisfies Record<ClaudeModel, { displayName: string }>;

export const claudeReasoningEfforts = {
  [ClaudeReasoningEffort.LOW]: {
    displayName: "low",
  },
  [ClaudeReasoningEffort.MAX]: {
    displayName: "max",
  },
} as const satisfies Record<ClaudeReasoningEffort, { displayName: string }>;

export const claudeAgentDefinitions = [
  {
    api: ClaudeApi.GLM,
    modelProvider: ModelProvider.GLM,
    provider: AgentProvider.CLAUDE,
    model: ClaudeModel.GLM_4_5_AIR,
    reasoningEffort: ClaudeReasoningEffort.LOW,
  },
  {
    api: ClaudeApi.GLM,
    modelProvider: ModelProvider.GLM,
    provider: AgentProvider.CLAUDE,
    model: ClaudeModel.GLM_5_3,
    reasoningEffort: ClaudeReasoningEffort.MAX,
  },
  {
    api: ClaudeApi.DEEPSEEK,
    modelProvider: ModelProvider.DEEPSEEK,
    provider: AgentProvider.CLAUDE,
    model: ClaudeModel.DEEPSEEK_V4_PRO,
    reasoningEffort: ClaudeReasoningEffort.MAX,
  },
  {
    api: ClaudeApi.DEEPSEEK,
    modelProvider: ModelProvider.DEEPSEEK,
    provider: AgentProvider.CLAUDE,
    model: ClaudeModel.DEEPSEEK_V4_FLASH,
    reasoningEffort: ClaudeReasoningEffort.MAX,
  },
] as const satisfies readonly {
  api: ClaudeApi;
  modelProvider: ModelProvider.DEEPSEEK | ModelProvider.GLM;
  provider: AgentProvider.CLAUDE;
  model: ClaudeModel;
  reasoningEffort: ClaudeReasoningEffort;
}[];

type ClaudeQueryFactory = (input: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

type ClaudeSessionOptions = Pick<
  Options,
  "forkSession" | "resume" | "resumeSessionAt" | "sessionId"
>;

type ActiveClaudeThread = {
  interrupt?: {
    promise: Promise<void>;
    turnId: string;
  };
  query: Query;
  turnId?: string;
};

type ClaudeTurnTaskState = {
  spawnedSubagentIds: Set<string>;
  liveSubagentIds: Set<string>;
};

export class ClaudeAgent extends BaseAgent {
  readonly id: string;
  override readonly supportsOutputSchema = true;
  private readonly activeThreads = new Map<string, ActiveClaudeThread>();
  private readonly taskState: ClaudeTurnTaskState = {
    spawnedSubagentIds: new Set(),
    liveSubagentIds: new Set(),
  };

  constructor(private readonly definition: ClaudeAgentDefinition) {
    super();
    this.id = definition.id;
  }

  async abort(threadId: string, turnId: string): Promise<void> {
    const activeThread = this.activeThreads.get(threadId);
    if (!activeThread || activeThread.turnId !== turnId) return;
    let interrupt = activeThread.interrupt;
    if (interrupt?.turnId !== turnId) {
      interrupt = {
        promise: activeThread.query.interrupt().then(() => undefined),
        turnId,
      };
      activeThread.interrupt = interrupt;
    }
    await interrupt.promise;
  }

  async copySkillsToWorkingDirectory(
    targetPath: string,
    skills?: WorkflowSkillSelection,
  ): Promise<void> {
    await copyAuditSkills({
      targetPath,
      agentConfigDirName: ".claude",
      skills,
    });
  }

  protected async createQuery(
    input: Parameters<ClaudeQueryFactory>[0],
  ): Promise<ReturnType<ClaudeQueryFactory>> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    return query(input);
  }

  private messageHandler(message: SDKMessage, logger: pino.Logger) {
    if (message.type === "system" && message.subtype === "thinking_tokens") {
      return;
    }

    let normalized: AgentMessage | undefined;
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "thinking" && block.thinking) {
          normalized = { type: "reasoning", content: block.thinking };
          break;
        }
        if (block.type === "text" && block.text) {
          normalized = { type: "assistant", content: block.text };
          break;
        }
        if (block.type === "tool_use") {
          normalized = {
            type: "tool_call",
            callId: block.id,
            tool: block.name,
            input: toJsonValue(block.input),
          };
          break;
        }
      }
    }
    const turnStatus: AgentTurnStatus | undefined =
      message.type === "result"
        ? message.subtype === "success"
          ? "completed"
          : "failed"
        : undefined;
    this.logAgentMessage(message, logger, normalized, turnStatus);

    if (message.type !== "system") return;
    if (
      message.subtype === "task_started" &&
      message.subagent_type !== undefined
    ) {
      this.taskState.spawnedSubagentIds.add(message.task_id);
      this.taskState.liveSubagentIds.add(message.task_id);
    } else if (message.subtype === "task_notification") {
      this.taskState.liveSubagentIds.delete(message.task_id);
    } else if (
      message.subtype === "task_updated" &&
      (message.patch.status === "completed" ||
        message.patch.status === "failed" ||
        message.patch.status === "killed")
    ) {
      this.taskState.liveSubagentIds.delete(message.task_id);
    } else if (message.subtype === "background_tasks_changed") {
      const backgroundTaskIds = new Set(
        message.tasks.map((task) => task.task_id),
      );
      for (const taskId of this.taskState.spawnedSubagentIds) {
        if (backgroundTaskIds.has(taskId)) {
          this.taskState.liveSubagentIds.add(taskId);
        } else {
          this.taskState.liveSubagentIds.delete(taskId);
        }
      }
    }
  }

  async runQuery(
    prompts: readonly string[],
    runOptions: ThreadOptions,
    logger: pino.Logger,
    skills?: WorkflowSkillSelection,
  ) {
    if (prompts.length === 0) return;
    const threadId = randomUUID();
    await this.runThread(
      threadId,
      prompts,
      runOptions,
      logger,
      { sessionId: threadId },
      skills,
    );
  }

  async runWithGoal(threadId: string, prompt: string): Promise<string> {
    void threadId;
    return `/goal ${prompt}`;
  }

  async newThread(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    const threadId = randomUUID();
    return this.runThread(
      threadId,
      prompts,
      options,
      logger,
      {
        sessionId: threadId,
      },
      options.skills,
    );
  }

  async resumeThread(
    threadId: string,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    return this.runThread(
      threadId,
      prompts,
      options,
      logger,
      {
        resume: threadId,
      },
      options.skills,
    );
  }

  async forkThread(
    threadId: string,
    lastTurnId: string | undefined,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    const forkedThreadId = randomUUID();
    return this.runThread(
      forkedThreadId,
      prompts,
      options,
      logger,
      {
        forkSession: true,
        resume: threadId,
        ...(lastTurnId ? { resumeSessionAt: lastTurnId } : {}),
        sessionId: forkedThreadId,
      },
      options.skills,
    );
  }

  private async runThread(
    threadId: string,
    prompts: readonly string[],
    runOptions: ThreadOptions,
    logger: pino.Logger,
    sessionOptions: ClaudeSessionOptions,
    skills?: WorkflowSkillSelection,
  ): Promise<AgentThreadResult> {
    const options = {
      ...this.createOptions(runOptions, skills),
      ...sessionOptions,
    };
    const messages = new AsyncMessageQueue<SDKUserMessage>();
    const sdkQuery = await this.createQuery({ prompt: messages, options });
    const activeThread: ActiveClaudeThread = { query: sdkQuery };
    this.activeThreads.set(threadId, activeThread);
    const promptLogger = logger;
    try {
      await runOptions.onThreadEvent?.({ type: "thread", threadId });
      this.taskState.spawnedSubagentIds.clear();
      this.taskState.liveSubagentIds.clear();
      let promptIndex = 0;
      let resultReceived = false;
      const turns: AgentThreadResult["turns"] = [];

      const sendPrompt = async (index: number) => {
        const prompt = prompts[index];
        if (prompt === undefined) {
          messages.close();
          return;
        }

        const turnId = randomUUID();
        activeThread.turnId = turnId;
        activeThread.interrupt = undefined;
        await runOptions.onThreadEvent?.({
          type: "turn",
          threadId,
          turnId,
        });
        throwIfInterrupted(activeThread, turnId);
        await runOptions.beforePrompt?.(index);
        throwIfInterrupted(activeThread, turnId);
        const promptForTurn = runOptions.goal
          ? await this.runWithGoal(threadId, prompt)
          : prompt;
        this.logUserMessage(promptForTurn, promptLogger);
        messages.push(userMessage(promptForTurn, threadId, turnId));
      };

      const maybeAdvanceTurn = async () => {
        if (
          !resultReceived ||
          [...this.taskState.spawnedSubagentIds].some((taskId) =>
            this.taskState.liveSubagentIds.has(taskId),
          )
        ) {
          return;
        }

        resultReceived = false;
        this.taskState.spawnedSubagentIds.clear();
        this.taskState.liveSubagentIds.clear();
        promptIndex += 1;
        await sendPrompt(promptIndex);
      };

      await sendPrompt(promptIndex);
      for await (const message of sdkQuery) {
        this.messageHandler(message, promptLogger);

        if (message.type !== "result" || isNotificationOnlyResult(message)) {
          await maybeAdvanceTurn();
          continue;
        }

        if (message.subtype !== "success") {
          if (message.subtype === "error_max_structured_output_retries") {
            throw new Error(
              message.errors.join("\n") ||
                "Claude could not produce output matching the requested JSON schema after the maximum retries.",
            );
          }
          throw new Error(
            message.errors.join("\n") ||
              `Claude stopped with ${message.subtype}`,
          );
        }
        if (resultReceived) continue;
        turns.push({
          ...(runOptions.outputSchema
            ? {
                structuredOutput: claudeStructuredOutput(
                  message,
                  runOptions.outputSchema,
                ),
              }
            : {}),
        });
        resultReceived = true;
        await maybeAdvanceTurn();
      }
      if (activeThread.interrupt) {
        throw abortError(
          `Claude Code turn ${activeThread.interrupt.turnId} was interrupted.`,
        );
      }
      return { threadId, turns };
    } catch (error) {
      const failure = activeThread.interrupt
        ? abortError(
            `Claude Code turn ${activeThread.interrupt.turnId} was interrupted.`,
          )
        : error;
      this.logAgentFailure(failure, promptLogger);
      throw failure;
    } finally {
      if (this.activeThreads.get(threadId) === activeThread) {
        this.activeThreads.delete(threadId);
      }
      messages.close();
      sdkQuery.close();
    }
  }

  private createOptions(
    { cwd, mcpServers = [], outputSchema, webSearch }: ThreadOptions,
    skills?: WorkflowSkillSelection,
  ): Options {
    return {
      allowDangerouslySkipPermissions: true,
      cwd,
      ...(webSearch === "disabled" ? { disallowedTools: ["WebSearch"] } : {}),
      effort: this.definition.reasoningEffort,
      env: claudeProcessEnvironment(this.definition),
      mcpServers: Object.fromEntries(
        mcpServers.map(({ headers, name, url }) => [
          name,
          { headers, type: "http" as const, url },
        ]),
      ),
      model: this.definition.model,
      ...(outputSchema
        ? {
            outputFormat: {
              type: "json_schema" as const,
              schema: claudeOutputSchema(outputSchema),
            },
          }
        : {}),
      permissionMode: "bypassPermissions",
      persistSession: true,
      settingSources: ["project"],
      ...(skills?.names ? { skills: [...skills.names] } : {}),
    };
  }
}

function claudeOutputSchema(outputSchema: Record<string, unknown>) {
  if (outputSchema.type !== "array") return outputSchema;
  const { $schema, ...arraySchema } = outputSchema;
  return {
    ...($schema === undefined ? {} : { $schema }),
    additionalProperties: false,
    properties: { items: arraySchema },
    required: ["items"],
    type: "object",
  };
}

function claudeStructuredOutput(
  message: { structured_output?: unknown },
  outputSchema: Record<string, unknown>,
) {
  const output = message.structured_output;
  if (output === undefined) {
    throw new Error("Claude completed without structured_output.");
  }
  if (outputSchema.type !== "array") return output;
  const wrapped = record(output);
  if (!Array.isArray(wrapped?.items)) {
    throw new Error("Claude returned an invalid structured array response.");
  }
  return wrapped.items;
}

function isNotificationOnlyResult(message: SDKMessage) {
  // A resumed session can drain restored task notifications before running the queued user turn.
  return (
    message.type === "result" &&
    message.subtype === "success" &&
    message.origin?.kind === "task-notification" &&
    message.num_turns === 0 &&
    message.result.length === 0 &&
    message.structured_output === undefined
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isClaudeApiAvailable(api: ClaudeApi) {
  const config = claudeApis[api];
  return Boolean(
    process.env[config.apiBaseUrlEnv]?.trim() &&
    process.env[config.apiKeyEnv]?.trim(),
  );
}

export function claudeProcessEnvironment(
  definition: Pick<ClaudeAgentDefinition, "api" | "model" | "reasoningEffort">,
) {
  const config = claudeApis[definition.api];
  const baseUrl = process.env[config.apiBaseUrlEnv]?.trim();
  const apiKey = process.env[config.apiKeyEnv]?.trim();

  if (!baseUrl) {
    throw new Error(
      `${config.apiBaseUrlEnv} is required for Claude API ${definition.api}`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `${config.apiKeyEnv} is required for Claude API ${definition.api}`,
    );
  }

  const environment = { ...process.env };
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  delete environment.ANTHROPIC_BASE_URL;
  for (const apiConfig of Object.values(claudeApis)) {
    delete environment[apiConfig.apiBaseUrlEnv];
    delete environment[apiConfig.apiKeyEnv];
  }

  return {
    ...environment,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: definition.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: definition.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: definition.model,
    ANTHROPIC_MODEL: definition.model,
    CLAUDE_CODE_EFFORT_LEVEL: definition.reasoningEffort,
    CLAUDE_CODE_SUBAGENT_MODEL: definition.model,
  };
}

function userMessage(
  prompt: string,
  sessionId: string,
  turnId: ReturnType<typeof randomUUID>,
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: turnId,
  };
}

function abortError(message: string) {
  return Object.assign(new Error(message), { name: "AbortError" });
}

function throwIfInterrupted(activeThread: ActiveClaudeThread, turnId: string) {
  if (activeThread.interrupt?.turnId === turnId) {
    throw abortError(`Claude Code turn ${turnId} was interrupted.`);
  }
}

class AsyncMessageQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  [Symbol.asyncIterator]() {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  push(value: T) {
    if (this.closed) throw new Error("Claude input queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}
