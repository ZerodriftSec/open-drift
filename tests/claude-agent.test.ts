import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import {
  ClaudeAgent,
  ClaudeApi,
  ClaudeModel,
  ClaudeReasoningEffort,
  claudeAgentDefinitions,
  claudeProcessEnvironment,
} from "@/audit/agent/claude";
import { registerAgentDefinitions } from "@/audit/agent/registry";
import { getWorkflowOutputDefinition } from "@/audit/output/registry";
import {
  AgentProvider,
  ModelProvider,
  type ClaudeAgentDefinition,
} from "@/audit/agent/types";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("registers GLM and DeepSeek Claude Code agents with stable IDs", () => {
  vi.stubEnv("GLM_API_BASE_URL", "https://glm.example/anthropic");
  vi.stubEnv("GLM_API_KEY", "glm-test-key");
  vi.stubEnv("DEEPSEEK_API_BASE_URL", "https://deepseek.example/anthropic");
  vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");

  const definitions = registerAgentDefinitions(claudeAgentDefinitions);

  expect(definitions).toMatchObject([
    {
      api: ClaudeApi.GLM,
      available: true,
      id: "claude-glm-4.7-low",
      model: ClaudeModel.GLM_4_5_AIR,
      modelProvider: ModelProvider.GLM,
      reasoningEffort: ClaudeReasoningEffort.LOW,
    },
    {
      api: ClaudeApi.GLM,
      available: true,
      displayName: "Claude Code | GLM-5.3 (max)",
      id: "claude-glm-5.3-max",
      model: ClaudeModel.GLM_5_3,
      modelProvider: ModelProvider.GLM,
      reasoningEffort: ClaudeReasoningEffort.MAX,
    },
    {
      api: ClaudeApi.DEEPSEEK,
      available: true,
      displayName: "Claude Code | DeepSeek V4 Pro (max)",
      id: "claude-deepseek-v4-pro-max",
      model: ClaudeModel.DEEPSEEK_V4_PRO,
      modelProvider: ModelProvider.DEEPSEEK,
      reasoningEffort: ClaudeReasoningEffort.MAX,
    },
    {
      api: ClaudeApi.DEEPSEEK,
      available: true,
      displayName: "Claude Code | DeepSeek V4 Flash (max)",
      id: "claude-deepseek-v4-flash-max",
      model: ClaudeModel.DEEPSEEK_V4_FLASH,
      modelProvider: ModelProvider.DEEPSEEK,
      reasoningEffort: ClaudeReasoningEffort.MAX,
    },
  ]);
});

test("marks a Claude Code agent unavailable when its API config is incomplete", () => {
  vi.stubEnv("DEEPSEEK_API_BASE_URL", "https://deepseek.example/anthropic");
  vi.stubEnv("DEEPSEEK_API_KEY", "");

  const definitions = registerAgentDefinitions([claudeAgentDefinitions[2]]);

  expect(definitions[0]?.available).toBe(false);
});

test("formats Goal-mode turns as a Claude /goal command", async () => {
  const [definition] = registerAgentDefinitions([claudeAgentDefinitions[0]]);
  if (!definition || definition.provider !== AgentProvider.CLAUDE) {
    throw new Error("Expected a Claude agent definition.");
  }

  const agent = new ClaudeAgent(definition);

  await expect(
    agent.runWithGoal("thread-1", "Review the migration."),
  ).resolves.toBe("/goal Review the migration.");
});

test("isolates the GLM API environment", () => {
  stubAllClaudeApiEnvironment();

  const environment = claudeProcessEnvironment({
    api: ClaudeApi.GLM,
    model: ClaudeModel.GLM_4_5_AIR,
    reasoningEffort: ClaudeReasoningEffort.LOW,
  });

  expect(environment).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: "glm-test-key",
    ANTHROPIC_BASE_URL: "https://glm.example/anthropic",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-4.7",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.7",
    ANTHROPIC_MODEL: "glm-4.7",
    CLAUDE_CODE_EFFORT_LEVEL: "low",
    CLAUDE_CODE_SUBAGENT_MODEL: "glm-4.7",
  });
  expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(environment).not.toHaveProperty("GLM_API_KEY");
  expect(environment).not.toHaveProperty("DEEPSEEK_API_KEY");
});

test("isolates the DeepSeek API environment", () => {
  stubAllClaudeApiEnvironment();

  const environment = claudeProcessEnvironment({
    api: ClaudeApi.DEEPSEEK,
    model: ClaudeModel.DEEPSEEK_V4_FLASH,
    reasoningEffort: ClaudeReasoningEffort.MAX,
  });

  expect(environment).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: "deepseek-test-key",
    ANTHROPIC_BASE_URL: "https://deepseek.example/anthropic",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-flash",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash",
    ANTHROPIC_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
  });
  expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(environment).not.toHaveProperty("GLM_API_KEY");
  expect(environment).not.toHaveProperty("DEEPSEEK_API_KEY");
});

test("reports the missing API-specific environment variable before startup", () => {
  vi.stubEnv("GLM_API_BASE_URL", "");
  vi.stubEnv("GLM_API_KEY", "glm-test-key");

  expect(() =>
    claudeProcessEnvironment({
      api: ClaudeApi.GLM,
      model: ClaudeModel.GLM_4_5_AIR,
      reasoningEffort: ClaudeReasoningEffort.LOW,
    }),
  ).toThrow("GLM_API_BASE_URL is required for Claude API glm");

  vi.stubEnv("GLM_API_BASE_URL", "https://glm.example/anthropic");
  vi.stubEnv("GLM_API_KEY", "");

  expect(() =>
    claudeProcessEnvironment({
      api: ClaudeApi.GLM,
      model: ClaudeModel.GLM_4_5_AIR,
      reasoningEffort: ClaudeReasoningEffort.LOW,
    }),
  ).toThrow("GLM_API_KEY is required for Claude API glm");
});

test("removes WebSearch when Web Search is disabled", async () => {
  vi.stubEnv("GLM_API_BASE_URL", "https://glm.example/anthropic");
  vi.stubEnv("GLM_API_KEY", "glm-test-key");
  const agent = createFakeClaudeAgent([
    {
      result: "Audit complete.",
      subtype: "success",
      type: "result",
    } as unknown as SDKMessage,
  ]);

  await agent.newThread(
    ["Audit the project."],
    { cwd: process.cwd(), webSearch: "disabled" },
    pino({ enabled: false }),
  );

  expect(agent.queryInput?.options?.disallowedTools).toEqual(["WebSearch"]);
});

test("wraps array schemas for Claude and unwraps structured_output", async () => {
  vi.stubEnv("GLM_API_BASE_URL", "https://glm.example/anthropic");
  vi.stubEnv("GLM_API_KEY", "glm-test-key");
  const outputSchema = getWorkflowOutputDefinition(
    "finding.submit-confirmed",
  ).jsonSchema;
  const agent = createFakeClaudeAgent([
    {
      result: '[{"finding_id":7}]',
      structured_output: { items: [{ finding_id: 7 }] },
      subtype: "success",
      type: "result",
    } as unknown as SDKMessage,
  ]);

  await expect(
    agent.newThread(
      ["Return findings."],
      { cwd: process.cwd(), outputSchema },
      pino({ enabled: false }),
    ),
  ).resolves.toMatchObject({
    turns: [{ structuredOutput: [{ finding_id: 7 }] }],
  });
  expect(agent.queryInput?.options?.outputFormat).toEqual({
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      properties: {
        items: Object.fromEntries(
          Object.entries(outputSchema).filter(([key]) => key !== "$schema"),
        ),
      },
      required: ["items"],
      type: "object",
    },
    type: "json_schema",
  });
  expect(outputSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
});

test("waits past notification-only results for structured output", async () => {
  vi.stubEnv("GLM_API_BASE_URL", "https://glm.example/anthropic");
  vi.stubEnv("GLM_API_KEY", "glm-test-key");
  const outputSchema = getWorkflowOutputDefinition(
    "finding.submit-confirmed",
  ).jsonSchema;
  const agent = createFakeClaudeAgent([
    {
      num_turns: 0,
      origin: { kind: "task-notification" },
      result: "",
      subtype: "success",
      type: "result",
    } as unknown as SDKMessage,
    {
      result: '[{"finding_id":7}]',
      structured_output: { items: [{ finding_id: 7 }] },
      subtype: "success",
      type: "result",
    } as unknown as SDKMessage,
  ]);

  await expect(
    agent.newThread(
      ["Return findings."],
      { cwd: process.cwd(), outputSchema },
      pino({ enabled: false }),
    ),
  ).resolves.toMatchObject({
    turns: [{ structuredOutput: [{ finding_id: 7 }] }],
  });
});

test("reports Claude structured output retry exhaustion explicitly", async () => {
  vi.stubEnv("GLM_API_BASE_URL", "https://glm.example/anthropic");
  vi.stubEnv("GLM_API_KEY", "glm-test-key");
  const agent = createFakeClaudeAgent([
    {
      errors: ["output did not match the schema"],
      subtype: "error_max_structured_output_retries",
      type: "result",
    } as unknown as SDKMessage,
  ]);

  await expect(
    agent.newThread(
      ["Return findings."],
      {
        cwd: process.cwd(),
        outputSchema: { items: {}, type: "array" },
      },
      pino({ enabled: false }),
    ),
  ).rejects.toThrow("output did not match the schema");
});

function stubAllClaudeApiEnvironment() {
  vi.stubEnv("ANTHROPIC_API_KEY", "global-api-key");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "global-auth-token");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://global.example/anthropic");
  vi.stubEnv("GLM_API_BASE_URL", "https://glm.example/anthropic");
  vi.stubEnv("GLM_API_KEY", "glm-test-key");
  vi.stubEnv("DEEPSEEK_API_BASE_URL", "https://deepseek.example/anthropic");
  vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
}

function createFakeClaudeAgent(messages: readonly SDKMessage[]) {
  const [definition] = registerAgentDefinitions([claudeAgentDefinitions[0]]);
  if (!definition || definition.provider !== AgentProvider.CLAUDE) {
    throw new Error("Expected a Claude agent definition.");
  }
  return new FakeClaudeAgent(definition, messages);
}

class FakeClaudeAgent extends ClaudeAgent {
  queryInput?: {
    options?: Options;
    prompt: string | AsyncIterable<SDKUserMessage>;
  };

  constructor(
    definition: ClaudeAgentDefinition,
    private readonly messages: readonly SDKMessage[],
  ) {
    super(definition);
  }

  protected override async createQuery(input: {
    options?: Options;
    prompt: string | AsyncIterable<SDKUserMessage>;
  }): Promise<Query> {
    this.queryInput = input;
    const messages = this.messages;
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      close: vi.fn(),
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as Query;
  }
}
