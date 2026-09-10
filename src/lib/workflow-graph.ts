import type { WorkflowStage } from "@/audit/workflow";

export function workflowNodePositions(workflow: {
  stages: readonly Pick<WorkflowStage, "dependsOn" | "name">[];
}) {
  const depthByName = new Map<string, number>();
  const countByDepth = new Map<number, number>();
  const result = new Map<string, { x: number; y: number }>();

  for (const stage of workflow.stages) {
    const depth = Math.max(
      0,
      ...(stage.dependsOn ?? []).map(
        (dependency) => (depthByName.get(dependency) ?? -1) + 1,
      ),
    );
    const indexAtDepth = countByDepth.get(depth) ?? 0;
    depthByName.set(stage.name, depth);
    countByDepth.set(depth, indexAtDepth + 1);
    result.set(stage.name, { x: depth * 360, y: indexAtDepth * 320 });
  }

  return result;
}
