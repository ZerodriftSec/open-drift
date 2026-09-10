import pino from "pino";
import { expect, test } from "vitest";

import {
  GeminiAgent,
  GeminiModel,
  GeminiReasoningEffort,
  geminiAgentDefinitions,
} from "@/audit/agent/gemini";
import { registerAgentDefinitions } from "@/audit/agent/registry";
import { AgentProvider, ModelProvider } from "@/audit/agent/types";

test("registers Gemini 3.7 Flash with high thinking", () => {
  const [definition] = registerAgentDefinitions(geminiAgentDefinitions);

  expect(definition).toMatchObject({
    displayName: "Gemini | 3.7 Flash (high)",
    id: "gemini-gemini-3.7-flash-high",
    model: GeminiModel.GEMINI_3_7_FLASH,
    modelProvider: ModelProvider.GEMINI,
    reasoningEffort: GeminiReasoningEffort.HIGH,
  });
});

test("rejects structured output before starting the Gemini runtime", async () => {
  const [definition] = registerAgentDefinitions([geminiAgentDefinitions[0]]);
  if (!definition || definition.provider !== AgentProvider.GEMINI) {
    throw new Error("Expected a Gemini agent definition.");
  }
  const agent = new GeminiAgent(definition);

  await expect(
    agent.newThread(
      ["Return findings."],
      {
        cwd: process.cwd(),
        outputSchema: { items: {}, type: "array" },
      },
      pino({ enabled: false }),
    ),
  ).rejects.toThrow("does not support workflow structured output schemas");
});
