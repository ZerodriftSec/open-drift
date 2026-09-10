import { vi } from "vitest";
import type pino from "pino";

import {
  BaseAgent,
  type AgentThreadResult,
  type ThreadOptions,
} from "@/audit/agent/base-agent";
import { codexAgentDefinitions } from "@/audit/agent/codex";

export type TestAgentEvent = {
  type: "test_agent.message" | "test_agent.completed";
  payload: Record<string, unknown>;
};

export type TestStructuredOutputFormatter = (
  prompts: readonly string[],
  options: ThreadOptions,
) => unknown | Promise<unknown>;

export const testAgentLogEvents: readonly TestAgentEvent[] = [
  {
    type: "test_agent.message",
    payload: {
      content: "Fixed response from the test Agent.",
      role: "assistant",
    },
  },
  {
    type: "test_agent.completed",
    payload: { status: "completed" },
  },
];

const testAgentDefinition = codexAgentDefinitions[0];

export class TestAgent extends BaseAgent {
  readonly id = [
    testAgentDefinition.provider,
    testAgentDefinition.model,
    testAgentDefinition.reasoningEffort,
  ].join("-");
  override readonly supportsOutputSchema = true;

  private structuredOutputFormatter?: TestStructuredOutputFormatter;
  private threadSequence = 0;

  setStructuredOutputFormatter(formatter: TestStructuredOutputFormatter) {
    this.structuredOutputFormatter = formatter;
  }

  async copySkillsToWorkingDirectory(): Promise<void> {}

  async runWithGoal(threadId: string, prompt: string): Promise<string> {
    void threadId;
    return prompt;
  }

  private readonly defaultRunQuery = async (
    prompts: readonly string[],
    _options: ThreadOptions,
    logger: pino.Logger,
  ) => {
    if (prompts.length === 0) return;

    for (const [promptIndex] of prompts.entries()) {
      await _options.beforePrompt?.(promptIndex);
    }
    for (const event of testAgentLogEvents) {
      logger.info({ agent_message: event });
    }
  };

  private readonly defaultNewThread = async (
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ) => {
    const threadId = `test-thread-${++this.threadSequence}`;
    await options.onThreadEvent?.({ type: "thread", threadId });
    await this.runThreadPrompts(prompts, options, logger);
    return testThreadResult(
      threadId,
      prompts,
      options,
      await this.formattedStructuredOutput(prompts, options),
    );
  };

  private readonly defaultResumeThread = async (
    threadId: string,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ) => {
    await options.onThreadEvent?.({ type: "thread", threadId });
    await this.runThreadPrompts(prompts, options, logger);
    return testThreadResult(
      threadId,
      prompts,
      options,
      await this.formattedStructuredOutput(prompts, options),
    );
  };

  private readonly defaultForkThread = async (
    sourceThreadId: string,
    lastTurnId: string | undefined,
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ) => {
    void sourceThreadId;
    void lastTurnId;
    const forkedThreadId = `test-thread-${++this.threadSequence}`;
    await options.onThreadEvent?.({
      type: "thread",
      threadId: forkedThreadId,
    });
    await this.runThreadPrompts(prompts, options, logger);
    return testThreadResult(
      forkedThreadId,
      prompts,
      options,
      await this.formattedStructuredOutput(prompts, options),
    );
  };

  private formattedStructuredOutput(
    prompts: readonly string[],
    options: ThreadOptions,
  ) {
    if (!options.outputSchema) return [];
    return this.structuredOutputFormatter
      ? this.structuredOutputFormatter(prompts, options)
      : [];
  }

  private async runThreadPrompts(
    prompts: readonly string[],
    options: ThreadOptions,
    logger: pino.Logger,
  ) {
    for (const [promptIndex] of prompts.entries()) {
      await options.beforePrompt?.(promptIndex);
    }
    for (const event of testAgentLogEvents) {
      logger.info({ agent_message: event });
    }
  }

  readonly runQuery = vi.fn(this.defaultRunQuery);
  readonly newThread = vi.fn(this.defaultNewThread);
  readonly resumeThread = vi.fn(this.defaultResumeThread);
  readonly forkThread = vi.fn(this.defaultForkThread);

  reset() {
    this.structuredOutputFormatter = undefined;
    this.threadSequence = 0;
    this.runQuery.mockReset();
    this.runQuery.mockImplementation(this.defaultRunQuery);
    this.newThread.mockReset();
    this.newThread.mockImplementation(this.defaultNewThread);
    this.resumeThread.mockReset();
    this.resumeThread.mockImplementation(this.defaultResumeThread);
    this.forkThread.mockReset();
    this.forkThread.mockImplementation(this.defaultForkThread);
  }
}

export function testThreadResult(
  threadId: string,
  prompts: readonly string[],
  options: ThreadOptions,
  structuredOutput: unknown = [],
): AgentThreadResult {
  return {
    threadId,
    turns: prompts.map(() =>
      options.outputSchema ? { structuredOutput } : {},
    ),
  };
}

export const testAgent = new TestAgent();

export const createAgentMock = vi.fn((agentId: string) => {
  void agentId;
  return testAgent;
});

export function resetAgentMocks() {
  testAgent.reset();
  createAgentMock.mockReset();
  createAgentMock.mockReturnValue(testAgent);
}
