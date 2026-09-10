import type { JsonValue } from "@/audit/session/types";
import type {
  ClaudeApi,
  ClaudeModel,
  ClaudeReasoningEffort,
} from "@/audit/agent/claude";
import type { CodexModel, CodexReasoningEffort } from "@/audit/agent/codex";
import type { GeminiModel, GeminiReasoningEffort } from "@/audit/agent/gemini";

export enum AgentProvider {
  CLAUDE = "claude",
  CODEX = "codex",
  GEMINI = "gemini",
}

export enum ModelProvider {
  GPT = "gpt",
  GLM = "glm",
  GEMINI = "gemini",
  DEEPSEEK = "deepseek",
}

type AgentDefinitionBase = {
  available: boolean;
  displayName: string;
  id: string;
  modelProvider: ModelProvider;
};

export type CodexAgentDefinition = AgentDefinitionBase & {
  modelProvider: ModelProvider.GPT;
  provider: AgentProvider.CODEX;
  model: CodexModel;
  reasoningEffort: CodexReasoningEffort;
};

export type ClaudeAgentDefinition = AgentDefinitionBase & {
  api: ClaudeApi;
  modelProvider: ModelProvider.DEEPSEEK | ModelProvider.GLM;
  provider: AgentProvider.CLAUDE;
  model: ClaudeModel;
  reasoningEffort: ClaudeReasoningEffort;
};

export type GeminiAgentDefinition = AgentDefinitionBase & {
  modelProvider: ModelProvider.GEMINI;
  provider: AgentProvider.GEMINI;
  model: GeminiModel;
  reasoningEffort: GeminiReasoningEffort;
};

export type AgentDefinition =
  ClaudeAgentDefinition | CodexAgentDefinition | GeminiAgentDefinition;

export type AgentMessage =
  | { type: "user"; content: string }
  | { type: "assistant"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; callId: string; tool: string; input: JsonValue };

export type AgentTurnStatus = "completed" | "failed";

export type AcpContextUsage = {
  used: number;
  size: number;
  cost?: {
    amount: number;
    currency: string;
    _meta?: Record<string, unknown> | null;
  } | null;
  _meta?: Record<string, unknown> | null;
};
