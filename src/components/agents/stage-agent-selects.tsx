"use client";

import type { AuditAgentDefinition } from "@/audit/agent/registry";
import type { WorkflowDefinitionSummary } from "@/server/workflows";
import { AgentIdCopyButton } from "@/app/components/agents/agent-id-copy";
import { AgentSelect } from "@/app/components/agents/agent-select";

export function defaultStageAgentIds(
  agents: AuditAgentDefinition[],
  workflows: WorkflowDefinitionSummary[],
  workflowId: string,
) {
  const workflow = workflows.find((workflow) => workflow.id === workflowId);
  const defaultAgentId =
    agents.find((agent) => agent.id === workflow?.defaultModel)?.id ??
    agents.find((agent) => agent.available)?.id ??
    agents[0]?.id ??
    "";
  return Array.from(
    { length: workflow?.stageCount ?? 0 },
    () => defaultAgentId,
  );
}

export function StageAgentSelects({
  agents,
  agentIds,
  disabled = false,
  name,
  onChange,
}: {
  agents: AuditAgentDefinition[];
  agentIds: string[];
  disabled?: boolean;
  name?: string;
  onChange: (agentIds: string[]) => void;
}) {
  return (
    <div className="grid gap-2">
      {agentIds.map((agentId, stageIndex) => (
        <div className="grid gap-1" key={stageIndex}>
          <span className="text-[11px] font-medium text-app-text-muted">
            Stage {stageIndex + 1}
          </span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
            <AgentSelect
              agents={agents}
              className="min-w-0 w-full"
              containerClassName="min-w-0 w-full"
              disabled={disabled}
              name={name}
              onChange={(nextAgentId) => {
                onChange(
                  agentIds.map((currentAgentId, index) =>
                    index === stageIndex ? nextAgentId : currentAgentId,
                  ),
                );
              }}
              value={agentId}
            />
            <AgentIdCopyButton agentId={agentId} />
          </div>
        </div>
      ))}
    </div>
  );
}
