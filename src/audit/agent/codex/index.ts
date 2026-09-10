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
  type CodexAgentDefinition,
} from "@/audit/agent/types";
import type { WorkflowSkillSelection } from "@/audit/workflow";
import { codexConfigOverrides } from "./config";
import {
  CodexAppServerClient,
  type CodexAppServerNotification,
  type CodexAppServerThread,
  type CodexAppServerThreadOptions,
} from "./app-server";

export enum CodexModel {
  GPT_5_3_CODEX_SPARK = "gpt-5.3-codex-spark",
  GPT_5_6_LUNA = "gpt-5.6-luna",
  GPT_5_6_SOL = "gpt-5.6-sol",
}

export enum CodexReasoningEffort {
  LOW = "low",
  MAX = "max",
}

export const codexReasoningEfforts = {
  [CodexReasoningEffort.LOW]: {
    displayName: "Low",
  },
  [CodexReasoningEffort.MAX]: {
    displayName: "max",
  },
} as const satisfies Record<CodexReasoningEffort, { displayName: string }>;

export const codexModels = {
  [CodexModel.GPT_5_3_CODEX_SPARK]: {
    displayName: "GPT 5.3 Codex Spark",
  },
  [CodexModel.GPT_5_6_LUNA]: {
    displayName: "GPT 5.6 Luna",
  },
  [CodexModel.GPT_5_6_SOL]: {
    displayName: "GPT 5.6 Sol",
  },
} as const satisfies Record<CodexModel, { displayName: string }>;

export const codexAgentDefinitions = [
  {
    modelProvider: ModelProvider.GPT,
    provider: AgentProvider.CODEX,
    model: CodexModel.GPT_5_3_CODEX_SPARK,
    reasoningEffort: CodexReasoningEffort.LOW,
  },
  {
    modelProvider: ModelProvider.GPT,
    provider: AgentProvider.CODEX,
    model: CodexModel.GPT_5_6_SOL,
    reasoningEffort: CodexReasoningEffort.MAX,
  },
  {
    modelProvider: ModelProvider.GPT,
    provider: AgentProvider.CODEX,
    model: CodexModel.GPT_5_6_LUNA,
    reasoningEffort: CodexReasoningEffort.MAX,
  },
] as const satisfies readonly {
  modelProvider: ModelProvider.GPT;
  provider: AgentProvider.CODEX;
  model: CodexModel;
  reasoningEffort: CodexReasoningEffort;
}[];

type ActiveCodexThread = {
  client: CodexAppServerClient;
  interrupt?: {
    promise: Promise<void>;
    turnId: string;
  };
  turnId?: string;
};

export class CodexAgent extends BaseAgent {
  readonly id: string;
  override readonly supportsOutputSchema = true;
  private readonly activeThreads = new Map<string, ActiveCodexThread>();

  constructor(private readonly definition: CodexAgentDefinition) {
    super();
    this.id = definition.id;
  }

  async abort(threadId: string, turnId: string): Promise<void> {
    const activeThread = this.activeThreads.get(threadId);
    if (!activeThread) return;
    await this.interruptActiveThread(threadId, turnId, activeThread);
  }

  async copySkillsToWorkingDirectory(
    targetPath: string,
    skills?: WorkflowSkillSelection,
  ): Promise<void> {
    await copyAuditSkills({
      targetPath,
      agentConfigDirName: ".agents",
      skills,
    });
  }

  async runQuery(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ) {
    if (prompts.length === 0) return;
    await this.newThread(prompts, options, logger);
  }

  async runWithGoal(threadId: string, prompt: string): Promise<string> {
    if (!this.activeThreads.has(threadId)) {
      throw new Error(`Codex thread ${threadId} is not active.`);
    }
    return prompt;
  }

  async newThread(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    return this.runThread(prompts, options, logger, (client, threadOptions) =>
      client.startThread(threadOptions),
    );
  }

  async resumeThread(
    threadId: string,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    return this.runThread(prompts, options, logger, (client, threadOptions) =>
      client.resumeThread(threadId, threadOptions),
    );
  }

  async forkThread(
    threadId: string,
    lastTurnId: string | undefined,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    return this.runThread(prompts, options, logger, (client, threadOptions) =>
      client.forkThread(threadId, lastTurnId, threadOptions),
    );
  }

  private async runThread(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
    openThread: (
      client: CodexAppServerClient,
      options: CodexAppServerThreadOptions,
    ) => Promise<CodexAppServerThread>,
  ): Promise<AgentThreadResult> {
    const promptLogger = logger;
    let client: CodexAppServerClient | undefined;
    let activeThread: ActiveCodexThread | undefined;
    let activeThreadId: string | undefined;
    try {
      client = await CodexAppServerClient.start({
        configOverrides: await codexConfigOverrides(),
        cwd: options.cwd,
        onNotification: (notification) => {
          this.messageHandler(notification, promptLogger);
        },
      });
      const thread = await openThread(
        client,
        this.createThreadOptions(options),
      );
      activeThreadId = thread.id;
      activeThread = {
        client,
      };
      this.activeThreads.set(thread.id, activeThread);
      await options.onThreadEvent?.({
        type: "thread",
        threadId: thread.id,
      });
      const turns: AgentThreadResult["turns"] = [];
      const outputSchema = codexOutputSchema(options.outputSchema);

      for (const [promptIndex, prompt] of prompts.entries()) {
        await options.beforePrompt?.(promptIndex);
        const promptForTurn = options.goal
          ? await this.runWithGoal(thread.id, prompt)
          : prompt;
        this.logUserMessage(promptForTurn, promptLogger);

        const onStarted = async (turnId: string) => {
          if (!activeThread) return;
          activeThread.turnId = turnId;
          await options.onThreadEvent?.({
            type: "turn",
            threadId: thread.id,
            turnId,
          });
        };
        const turn = await (
          options.goal
            ? client.runGoal({
                onStarted,
                prompt: promptForTurn,
                threadId: thread.id,
              })
            : client.runTurn({
                effort: this.reasoningEffort(),
                onStarted,
                outputSchema,
                prompt: promptForTurn,
                threadId: thread.id,
              })
        ).finally(() => {
          if (!activeThread) return;
          activeThread.turnId = undefined;
          activeThread.interrupt = undefined;
        });
        if (turn.status === "interrupted") {
          throw abortError(`Codex turn ${turn.id} was interrupted.`);
        }
        if (turn.status !== "completed") {
          throw new Error(
            turn.error ?? `Codex turn ${turn.id} ended with ${turn.status}.`,
          );
        }
        turns.push({
          ...(options.outputSchema
            ? {
                structuredOutput: parseStructuredOutput(
                  turn.agentMessage,
                  options.outputSchema,
                ),
              }
            : {}),
        });
      }
      return { threadId: thread.id, turns };
    } catch (error) {
      this.logAgentFailure(error, promptLogger);
      throw error;
    } finally {
      if (
        activeThreadId &&
        activeThread &&
        this.activeThreads.get(activeThreadId) === activeThread
      ) {
        this.activeThreads.delete(activeThreadId);
      }
      await client?.close();
    }
  }

  private interruptActiveThread(
    threadId: string,
    turnId: string,
    activeThread: ActiveCodexThread,
  ) {
    if (activeThread.turnId !== turnId) return Promise.resolve();
    if (activeThread.interrupt?.turnId !== turnId) {
      activeThread.interrupt = {
        promise: activeThread.client.interruptTurn(threadId, turnId),
        turnId,
      };
    }
    return activeThread.interrupt.promise;
  }

  private messageHandler(
    notification: CodexAppServerNotification,
    logger: pino.Logger,
  ) {
    if (notification.method === "item/agentMessage/delta") return;

    const params = record(notification.params);
    const item = record(params?.item);
    let normalized: AgentMessage | undefined;
    if (notification.method === "item/completed" && item) {
      if (item.type === "agentMessage" && typeof item.text === "string") {
        normalized = { type: "assistant", content: item.text };
      } else if (item.type === "reasoning") {
        const content = textList(item.content) || textList(item.summary);
        if (content) normalized = { type: "reasoning", content };
      }
    } else if (notification.method === "item/started" && item) {
      if (
        item.type === "commandExecution" &&
        typeof item.command === "string"
      ) {
        normalized = {
          type: "tool_call",
          callId: string(item.id) ?? "command",
          tool: "Bash",
          input: { command: item.command },
        };
      } else if (
        item.type === "mcpToolCall" &&
        typeof item.server === "string" &&
        typeof item.tool === "string"
      ) {
        normalized = {
          type: "tool_call",
          callId: string(item.id) ?? "mcp",
          tool: `mcp__${item.server}__${item.tool}`,
          input: toJsonValue(item.arguments),
        };
      }
    }
    const turnStatus: AgentTurnStatus | undefined =
      notification.method === "turn/completed"
        ? record(params?.turn)?.status === "completed"
          ? "completed"
          : "failed"
        : notification.method === "error" && params?.willRetry !== true
          ? "failed"
          : undefined;
    this.logAgentMessage(notification, logger, normalized, turnStatus);
  }

  private createThreadOptions({
    cwd,
    mcpServers = [],
    sandbox,
    webSearch,
  }: ThreadOptions): CodexAppServerThreadOptions {
    const options: CodexAppServerThreadOptions = {
      config: {
        model_reasoning_effort: this.reasoningEffort(),
        ...(mcpServers.length > 0
          ? {
              mcp_servers: Object.fromEntries(
                mcpServers.map(({ headers, name, url }) => [
                  name,
                  { http_headers: headers, url },
                ]),
              ),
            }
          : {}),
        ...(webSearch ? { web_search: webSearch } : {}),
      },
      cwd,
      model: this.definition.model,
      // Reuse Codex's cached OpenAI login instead of a machine-level custom provider.
      modelProvider: "openai",
      ...(sandbox ? { sandbox } : {}),
    };

    return options;
  }

  private reasoningEffort() {
    return this.definition.reasoningEffort;
  }
}

function codexOutputSchema(outputSchema: ThreadOptions["outputSchema"]) {
  if (outputSchema?.type !== "array") return outputSchema;
  const { $schema, ...arraySchema } = outputSchema;
  return {
    ...($schema === undefined ? {} : { $schema }),
    additionalProperties: false,
    properties: { items: arraySchema },
    required: ["items"],
    type: "object",
  };
}

function parseStructuredOutput(
  agentMessage: string | undefined,
  outputSchema: NonNullable<ThreadOptions["outputSchema"]>,
) {
  if (!agentMessage) {
    throw new Error("Codex completed without a structured final response.");
  }
  let output: unknown;
  try {
    output = JSON.parse(agentMessage) as unknown;
  } catch (error) {
    throw new Error("Codex returned invalid structured JSON output.", {
      cause: error,
    });
  }
  if (outputSchema.type !== "array") return output;
  const wrapped = record(output);
  if (!Array.isArray(wrapped?.items)) {
    throw new Error("Codex returned an invalid structured array response.");
  }
  return wrapped.items;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function textList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : undefined;
}

function abortError(message: string) {
  return Object.assign(new Error(message), { name: "AbortError" });
}
