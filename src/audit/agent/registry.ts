import { AgentProvider, type AgentDefinition } from "@/audit/agent/types";
import {
  ClaudeAgent,
  claudeAgentDefinitions,
  claudeModels,
  claudeReasoningEfforts,
  isClaudeApiAvailable,
} from "@/audit/agent/claude";
import { ClaudeUsage } from "@/audit/agent/claude/usage";
import {
  CodexAgent,
  codexAgentDefinitions,
  codexModels,
  codexReasoningEfforts,
} from "@/audit/agent/codex";
import { CodexUsage } from "@/audit/agent/codex/usage";
import {
  GeminiAgent,
  geminiAgentDefinitions,
  geminiModels,
  geminiReasoningEfforts,
} from "@/audit/agent/gemini";
import { GeminiUsage } from "@/audit/agent/gemini/usage";
import type { BaseAgent } from "@/audit/agent/base-agent";
import type { BaseUsage } from "@/audit/agent/usage";

export type AuditAgentDefinition = AgentDefinition;
export type AgentId = string;

export type AgentRegistration =
  | Omit<
      Extract<AgentDefinition, { provider: AgentProvider.CLAUDE }>,
      "available" | "displayName" | "id"
    >
  | Omit<
      Extract<AgentDefinition, { provider: AgentProvider.CODEX }>,
      "available" | "displayName" | "id"
    >
  | Omit<
      Extract<AgentDefinition, { provider: AgentProvider.GEMINI }>,
      "available" | "displayName" | "id"
    >;

const agentProviders = {
  [AgentProvider.CLAUDE]: { displayName: "Claude Code" },
  [AgentProvider.CODEX]: { displayName: "Codex" },
  [AgentProvider.GEMINI]: { displayName: "Gemini" },
} as const satisfies Record<AgentProvider, { displayName: string }>;

const registrations: readonly AgentRegistration[] = [
  ...claudeAgentDefinitions,
  ...codexAgentDefinitions,
  ...geminiAgentDefinitions,
];

const definitions = registerAgentDefinitions(registrations);

const byId = new Map(
  definitions.map((definition) => [definition.id, definition]),
);

export function listAgentDefinitions(): AuditAgentDefinition[] {
  return definitions.map((definition) => ({ ...definition }));
}

export function normalizeAgentId(value: string) {
  const id = value.trim();
  const definition = byId.get(id);
  if (!definition) {
    throw new Error(
      `Invalid agent: ${value}. Expected ${definitions.map((item) => item.id).join(", ")}.`,
    );
  }
  return id;
}

export function getAgentDefinition(agentId: string): AuditAgentDefinition {
  const definition = byId.get(normalizeAgentId(agentId));
  if (!definition) throw new Error(`Agent not found: ${agentId}`);
  return { ...definition };
}

export function createAgent(agentId: string): BaseAgent {
  const definition = byId.get(normalizeAgentId(agentId));
  if (!definition) throw new Error(`Agent not found: ${agentId}`);
  switch (definition.provider) {
    case AgentProvider.CLAUDE:
      return new ClaudeAgent(definition);
    case AgentProvider.CODEX:
      return new CodexAgent(definition);
    case AgentProvider.GEMINI:
      return new GeminiAgent(definition);
  }
}

export function createUsageParser(agentId: string): BaseUsage {
  const definition = byId.get(normalizeAgentId(agentId));
  if (!definition) throw new Error(`Agent not found: ${agentId}`);
  switch (definition.provider) {
    case AgentProvider.CLAUDE:
      return new ClaudeUsage(definition.model);
    case AgentProvider.CODEX:
      return new CodexUsage(definition.model);
    case AgentProvider.GEMINI:
      return new GeminiUsage(definition.model);
  }
}

function createAgentDefinition(
  registration: AgentRegistration,
): AuditAgentDefinition {
  return Object.freeze({
    ...registration,
    available: agentAvailable(registration),
    displayName: agentDisplayName(registration),
    id: agentId(registration),
  }) as AuditAgentDefinition;
}

function agentAvailable(registration: AgentRegistration) {
  return registration.provider === AgentProvider.CLAUDE
    ? isClaudeApiAvailable(registration.api)
    : true;
}

export function registerAgentDefinitions(
  registrations: readonly AgentRegistration[],
): readonly AuditAgentDefinition[] {
  const definitions = registrations.map(createAgentDefinition);
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`Duplicate agent ID: ${definition.id}`);
    }
    ids.add(definition.id);
  }
  return Object.freeze(definitions);
}

function agentId(registration: AgentRegistration): AgentId {
  return [
    registration.provider,
    registration.model,
    registration.reasoningEffort,
  ].join("-");
}

function agentDisplayName(registration: AgentRegistration) {
  const provider = agentProviders[registration.provider].displayName;
  switch (registration.provider) {
    case AgentProvider.CLAUDE:
      return `${provider} | ${claudeModels[registration.model].displayName} (${claudeReasoningEfforts[registration.reasoningEffort].displayName})`;
    case AgentProvider.CODEX:
      return `${provider} | ${codexModels[registration.model].displayName} (${codexReasoningEfforts[registration.reasoningEffort].displayName})`;
    case AgentProvider.GEMINI:
      return `${provider} | ${geminiModels[registration.model].displayName} (${geminiReasoningEfforts[registration.reasoningEffort].displayName})`;
  }
}
