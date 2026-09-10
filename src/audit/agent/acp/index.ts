import type { McpServer, SessionUpdate } from "@agentclientprotocol/sdk";
import type pino from "pino";
import {
  BaseAgent,
  toJsonValue,
  type AgentThreadResult,
  type ThreadOptions,
} from "@/audit/agent/base-agent";
import type { AgentMessage, AgentTurnStatus } from "@/audit/agent/types";
import {
  createAcpRuntimeSession,
  forkAcpRuntimeSession,
  resumeAcpRuntimeSession,
  type AcpRuntimeDefinition,
  type AcpRuntimeResult,
  type AcpRuntimeSession,
  type AcpRuntimeSessionInput,
} from "./runtime";

type AcpAgentMessage = { event: string; payload: unknown } | AcpRuntimeResult;

type ActiveAcpThread = {
  interrupt?: {
    promise: Promise<void>;
    turnId: string;
  };
  session: AcpRuntimeSession;
  turnId?: string;
};

export abstract class AcpAgent extends BaseAgent {
  private readonly activeThreads = new Map<string, ActiveAcpThread>();

  protected abstract createRuntime():
    Promise<AcpRuntimeDefinition> | AcpRuntimeDefinition;

  async abort(threadId: string, turnId: string): Promise<void> {
    const activeThread = this.activeThreads.get(threadId);
    if (!activeThread || activeThread.turnId !== turnId) return;
    if (activeThread.interrupt?.turnId !== turnId) {
      activeThread.interrupt = {
        promise: activeThread.session.cancel(),
        turnId,
      };
    }
    await activeThread.interrupt.promise;
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
    void threadId;
    return prompt;
  }

  async newThread(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    return this.runThread(prompts, options, logger, (input) =>
      createAcpRuntimeSession(input),
    );
  }

  async resumeThread(
    threadId: string,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    return this.runThread(prompts, options, logger, (input) =>
      resumeAcpRuntimeSession(threadId, input),
    );
  }

  async forkThread(
    threadId: string,
    lastTurnId: string | undefined,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult> {
    void lastTurnId;
    return this.runThread(prompts, options, logger, (input) =>
      forkAcpRuntimeSession(threadId, input),
    );
  }

  private async runThread(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
    openSession: (input: AcpRuntimeSessionInput) => Promise<AcpRuntimeSession>,
  ): Promise<AgentThreadResult> {
    if (options.outputSchema) {
      throw new Error(
        `${this.id} does not support workflow structured output schemas.`,
      );
    }
    const promptLogger = logger;
    let session: AcpRuntimeSession;
    try {
      session = await openSession({
        cwd: options.cwd,
        launch: await this.createRuntime(),
        mcpServers: (options.mcpServers ?? []).map(
          ({ headers, name, url }): McpServer => ({
            type: "http",
            name,
            url,
            headers: Object.entries(headers).map(([headerName, value]) => ({
              name: headerName,
              value,
            })),
          }),
        ),
        onRawEvent: (event, payload) => {
          this.messageHandler({ event, payload }, promptLogger);
        },
      });
    } catch (error) {
      this.logAgentFailure(error, promptLogger);
      throw error;
    }

    const activeThread: ActiveAcpThread = { session };
    this.activeThreads.set(session.sessionId, activeThread);
    try {
      await options.onThreadEvent?.({
        type: "thread",
        threadId: session.sessionId,
      });

      const turns: AgentThreadResult["turns"] = [];
      for (const [promptIndex, prompt] of prompts.entries()) {
        await options.beforePrompt?.(promptIndex);
        const promptForTurn = options.goal
          ? await this.runWithGoal(session.sessionId, prompt)
          : prompt;
        this.logUserMessage(promptForTurn, promptLogger);

        const turnId = `${session.sessionId}:${promptIndex}`;
        activeThread.turnId = turnId;
        activeThread.interrupt = undefined;
        const resultPromise = session.runTurn({ prompt: promptForTurn });
        const result = await (async () => {
          try {
            await options.onThreadEvent?.({
              type: "turn",
              threadId: session.sessionId,
              turnId,
            });
            return await resultPromise;
          } catch (error) {
            await session.cancel().catch(() => undefined);
            await resultPromise.catch(() => undefined);
            throw error;
          } finally {
            activeThread.turnId = undefined;
            activeThread.interrupt = undefined;
          }
        })();
        this.messageHandler(result, promptLogger);
        if (result.status === "interrupted") {
          throw Object.assign(new Error("Agent query interrupted"), {
            name: "AbortError",
          });
        }
        if (result.status === "failed") {
          throw new Error(result.error?.message ?? "Agent query failed");
        }
        turns.push({});
      }
      return { threadId: session.sessionId, turns };
    } catch (error) {
      this.logAgentFailure(error, promptLogger);
      throw error;
    } finally {
      if (this.activeThreads.get(session.sessionId) === activeThread) {
        this.activeThreads.delete(session.sessionId);
      }
      await session.close();
    }
  }

  private messageHandler(message: AcpAgentMessage, logger: pino.Logger) {
    let normalized: AgentMessage | undefined;
    if ("event" in message) {
      const update = message.payload as SessionUpdate;
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = contentText(update.content);
        if (content) normalized = { type: "assistant", content };
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        const content = contentText(update.content);
        if (content) normalized = { type: "reasoning", content };
      } else if (update.sessionUpdate === "user_message_chunk") {
        const content = contentText(update.content);
        if (content) normalized = { type: "user", content };
      } else if (update.sessionUpdate === "tool_call") {
        normalized = {
          type: "tool_call",
          callId: update.toolCallId,
          tool: update.title,
          input: toJsonValue(update.rawInput),
        };
      }
    }
    const turnStatus: AgentTurnStatus | undefined =
      "event" in message
        ? undefined
        : message.status === "completed"
          ? "completed"
          : "failed";
    this.logAgentMessage(message, logger, normalized, turnStatus);
  }
}

function contentText(content: unknown) {
  if (!content || typeof content !== "object") return undefined;
  const record = content as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : undefined;
}

export { acpUpdateToAgentMessage } from "./messages";
export {
  createAcpRuntimeSession,
  runAcpPrompt,
  type AcpRuntimeDefinition,
} from "./runtime";
