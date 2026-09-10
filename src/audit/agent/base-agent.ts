import type pino from "pino";
import type { JsonValue } from "@/audit/session/types";
import type { WorkflowMcp } from "@/audit/mcp/registry";
import type { WorkflowSkillSelection } from "@/audit/workflow";
import type { AgentMessage, AgentTurnStatus } from "./types";

export type ThreadEvent =
  | {
      type: "thread";
      threadId: string;
    }
  | { type: "turn"; threadId: string; turnId: string };

export type ThreadOptions = {
  beforePrompt?: (promptIndex: number) => void | Promise<void>;
  cwd: string;
  goal?: boolean;
  mcpServers?: readonly WorkflowMcp[];
  onThreadEvent?: (event: ThreadEvent) => void | Promise<void>;
  outputSchema?: Record<string, unknown>;
  sandbox?: "danger-full-access" | "read-only";
  skills?: WorkflowSkillSelection;
  webSearch?: "disabled" | "live";
};

export type AgentTurnResult = {
  structuredOutput?: unknown;
};

export type AgentThreadResult = {
  threadId: string;
  turns: AgentTurnResult[];
};

/**
 * The provider-neutral Agent contract.
 *
 * One runQuery call owns one native provider session. Prompts are sent in
 * order so every prompt in the array shares that provider context.
 */
export abstract class BaseAgent {
  abstract readonly id: string;
  readonly supportsOutputSchema: boolean = false;

  async abort(threadId: string, turnId: string): Promise<void> {
    void threadId;
    void turnId;
    throw new Error(`${this.id} does not support aborting threads.`);
  }

  protected logAgentMessage(
    rawMessage: unknown,
    logger: pino.Logger,
    message?: AgentMessage,
    turnStatus?: AgentTurnStatus,
  ) {
    logger.info({
      agent_message: rawMessage,
      ...(message ? { message } : {}),
      ...(turnStatus ? { turnStatus } : {}),
    });
  }

  protected logUserMessage(content: string, logger: pino.Logger) {
    const message = { type: "user", content } as const satisfies AgentMessage;
    this.logAgentMessage(message, logger, message);
  }

  protected logAgentFailure(error: unknown, logger: pino.Logger) {
    this.logAgentMessage(
      {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      },
      logger,
      undefined,
      "failed",
    );
  }

  /**
   * Prepares a prompt for Goal mode. Providers can either set native thread
   * goal state and return the original prompt, or return a command-prefixed one.
   */
  abstract runWithGoal(threadId: string, prompt: string): Promise<string>;

  abstract newThread(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult>;

  abstract resumeThread(
    threadId: string,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult>;

  abstract forkThread(
    threadId: string,
    lastTurnId: string | undefined,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ): Promise<AgentThreadResult>;

  abstract copySkillsToWorkingDirectory(
    targetPath: string,
    skills?: WorkflowSkillSelection,
  ): Promise<void>;

  abstract runQuery(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
    skills?: WorkflowSkillSelection,
  ): Promise<void>;
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
