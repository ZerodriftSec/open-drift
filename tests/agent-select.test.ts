import { expect, test } from "vitest";

import { ClaudeModel } from "@/audit/agent/claude";
import { CodexModel } from "@/audit/agent/codex";
import { listAgentDefinitions } from "@/audit/agent/registry";
import { AgentProvider } from "@/audit/agent/types";
import { groupAgents } from "@/components/agents/agent-select";

test("sorts models in each Agent group by version, newest first", () => {
  const groups = groupAgents(listAgentDefinitions());

  expect(
    groups
      .find((group) => group.id === AgentProvider.CLAUDE)
      ?.agents.map((agent) => agent.model),
  ).toEqual([
    ClaudeModel.GLM_5_3,
    ClaudeModel.GLM_4_5_AIR,
    ClaudeModel.DEEPSEEK_V4_PRO,
    ClaudeModel.DEEPSEEK_V4_FLASH,
  ]);
  expect(
    groups
      .find((group) => group.id === AgentProvider.CODEX)
      ?.agents.map((agent) => agent.model),
  ).toEqual([
    CodexModel.GPT_5_6_SOL,
    CodexModel.GPT_5_6_LUNA,
    CodexModel.GPT_5_3_CODEX_SPARK,
  ]);
});
