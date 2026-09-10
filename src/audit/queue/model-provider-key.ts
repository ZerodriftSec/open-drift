import { getAgentDefinition } from "@/audit/agent/registry";

export function modelProviderQueueKey(agentIds: readonly string[]) {
  const modelProviders = [
    ...new Set(
      agentIds.map((agentId) => getAgentDefinition(agentId).modelProvider),
    ),
  ].sort();

  if (modelProviders.length === 0) {
    throw new Error("Model provider queue requires at least one Agent.");
  }

  return modelProviders.join("+");
}
