import type { WorkflowDefinition } from "@/audit/workflow";
import type {
  WorkflowStageStatus,
  WorkflowStateSnapshot,
  WorkflowTurnStatus,
} from "@/audit/workflow/status";

export type WorkflowPromptProgress = {
  outputSchema?: string;
  promptIndex: number;
  runCount: number;
  status: WorkflowTurnStatus;
  title: string;
};

export type WorkflowStageProgress = {
  attempt: number;
  name: string;
  nodeId: string;
  promptCount: number;
  prompts: readonly WorkflowPromptProgress[];
  stageIndex: number;
  status: WorkflowStageStatus;
};

export function workflowProgressFromWorkflowState(
  workflow: WorkflowDefinition,
  state: WorkflowStateSnapshot,
): readonly WorkflowStageProgress[] {
  return state.stages.map((stageState) => {
    const stage = workflow.stages[stageState.stageIndex];
    const prompts = stageState.turns.map((turnState) => ({
      outputSchema: stage?.turns[turnState.turnIndex]?.outputSchema,
      promptIndex: turnState.turnIndex,
      runCount: turnState.runCount,
      status: turnState.status,
      title: workflowPromptTitle(
        stage?.turns[turnState.turnIndex]?.prompt ?? "",
      ),
    }));

    return {
      attempt: stageState.attempt,
      name: stage?.name ?? `Stage ${stageState.stageIndex + 1}`,
      nodeId: stage?.name ?? String(stageState.stageIndex),
      promptCount: prompts.length,
      prompts,
      stageIndex: stageState.stageIndex,
      status: stageState.status,
    };
  });
}

function workflowPromptTitle(prompt: string) {
  return prompt.trim() || "Untitled prompt";
}
