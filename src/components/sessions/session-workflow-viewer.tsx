"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Check,
  CheckCircle2,
  Circle,
  CircleDashed,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { requestJson } from "@/app/components/lib/api-client";
import { useApiMutation } from "@/app/components/lib/use-api-mutation";
import { Button } from "@/app/components/ui/button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { WorkflowDefinition } from "@/audit/workflow";
import {
  workflowStateSchema,
  type WorkflowStageStatus,
  type WorkflowStateSnapshot,
  type WorkflowTurnStatus,
} from "@/audit/workflow/status";
import type { AuditStatus } from "@/audit/session/types";
import {
  workflowProgressFromWorkflowState,
  type WorkflowStageProgress,
} from "@/lib/workflow-progress";
import { workflowNodePositions } from "@/lib/workflow-graph";

type SerializedWorkflowDefinition = ReturnType<WorkflowDefinition["toJSON"]>;

type SessionWorkflowNodeData = {
  agentId?: string;
  onRunStage: (stageIndex: number) => void;
  runDisabled: boolean;
  runLoading: boolean;
  stage: WorkflowStageProgress;
};

type SessionWorkflowNode = Node<SessionWorkflowNodeData, "workflowStage">;

const auditStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
  "wait",
]);

const sessionStatusResponseSchema = z
  .object({
    workflowState: workflowStateSchema,
    status: auditStatusSchema,
  })
  .passthrough();

const runStageResponseSchema = z
  .object({
    attempt: z.number().int().positive(),
    sessionId: z.string().min(1),
    stageIndex: z.number().int().nonnegative(),
    status: auditStatusSchema,
    workflowState: workflowStateSchema,
  })
  .passthrough();

const refreshWorkflowResponseSchema = z
  .object({
    message: z.string(),
    sessionId: z.string().min(1),
    workflowId: z.string().min(1),
  })
  .passthrough();

const nodeTypes = { workflowStage: SessionWorkflowStageNode };

export function SessionWorkflowViewer({
  agents,
  initialSessionStatus,
  initialWorkflowState,
  sessionId,
  workflowDefinition,
}: {
  agents: readonly string[];
  initialSessionStatus: AuditStatus;
  initialWorkflowState: WorkflowStateSnapshot;
  sessionId: string;
  workflowDefinition: SerializedWorkflowDefinition;
}) {
  const workflow = useMemo(
    () => new WorkflowDefinition(workflowDefinition),
    [workflowDefinition],
  );
  const runStageMutation = useApiMutation<
    z.infer<typeof runStageResponseSchema>,
    number
  >({
    invalidateKeys: [["sessions"], ["session-workflow-status", sessionId]],
    mutationFn: (stageIndex) =>
      requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/stages/${stageIndex}/run`,
        { method: "POST" },
        runStageResponseSchema,
        "Failed to run Stage",
      ),
    refresh: false,
    successMessage: (result) =>
      `Stage ${result.stageIndex + 1} attempt ${result.attempt} completed`,
  });
  const refreshWorkflowMutation = useApiMutation<
    z.infer<typeof refreshWorkflowResponseSchema>
  >({
    invalidateKeys: [["sessions"], ["session-workflow-status", sessionId]],
    mutationFn: () =>
      requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/workflow/refresh`,
        { method: "POST" },
        refreshWorkflowResponseSchema,
        "Failed to sync Workflow",
      ),
    successMessage: (result) => result.message,
  });
  const statusQuery = useQuery({
    initialData: {
      status: initialSessionStatus,
      workflowState: initialWorkflowState,
    },
    queryFn: async () => {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/status`,
        {
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to read Session status: ${response.status}`);
      }
      return sessionStatusResponseSchema.parse(await response.json());
    },
    queryKey: ["session-workflow-status", sessionId],
    refetchInterval: (query) =>
      runStageMutation.isPending || shouldPollWorkflowStatus(query.state.data)
        ? 1500
        : false,
    refetchIntervalInBackground: false,
  });
  const workflowState = statusQuery.data.workflowState;
  const stages = useMemo(
    () => workflowProgressFromWorkflowState(workflow, workflowState),
    [workflow, workflowState],
  );
  const sessionBusy =
    statusQuery.data.status === "queued" ||
    statusQuery.data.status === "running";
  const sessionRunning = statusQuery.data.status === "running";
  const runStage = runStageMutation.mutate;
  const nodes = useMemo(
    () =>
      workflowNodes(workflow, stages, agents, {
        onRunStage: runStage,
        runDisabled: sessionBusy || runStageMutation.isPending,
        runningStageIndex: runStageMutation.isPending
          ? runStageMutation.variables
          : undefined,
      }),
    [
      agents,
      runStage,
      runStageMutation.isPending,
      runStageMutation.variables,
      sessionBusy,
      stages,
      workflow,
    ],
  );
  const edges = useMemo(
    () => workflowEdges(workflow, stages),
    [stages, workflow],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <section
        aria-label="Read-only Session Workflow progress graph"
        className="relative min-h-0 min-w-0 flex-1 bg-app-canvas"
      >
        <ReactFlow<SessionWorkflowNode, Edge>
          edges={edges}
          edgesReconnectable={false}
          elementsSelectable={false}
          fitView
          maxZoom={1.5}
          minZoom={0.25}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          nodeTypes={nodeTypes}
          onNodeClick={allowNodeInteractions}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            color="rgba(55, 53, 47, 0.11)"
            gap={18}
            size={1}
            variant={BackgroundVariant.Dots}
          />
          <Controls showInteractive={false} />
          <Panel position="top-right">
            <Button
              className="nodrag nopan shadow-app"
              disabled={sessionRunning}
              icon={RefreshCw}
              loading={refreshWorkflowMutation.isPending}
              onClick={() => refreshWorkflowMutation.mutate()}
              size="sm"
              title={
                sessionRunning
                  ? "Workflow cannot be synced while the Session is running"
                  : "Replace the current Session snapshot with the latest Workflow definition"
              }
              type="button"
              variant="secondary"
            >
              Sync Workflow
            </Button>
          </Panel>
        </ReactFlow>
        {nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">
            This Workflow has no Stages
          </div>
        ) : null}
        <div className="pointer-events-none absolute bottom-3 right-3 rounded-app border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow-app backdrop-blur">
          Pan, zoom, and fit the view · Nodes and edges are read-only
        </div>
      </section>
    </div>
  );
}

function SessionWorkflowStageNode({ data }: NodeProps<SessionWorkflowNode>) {
  const { agentId, onRunStage, runDisabled, runLoading, stage } = data;
  return (
    <article
      aria-label={`${stage.name}, ${stageStatusLabel(stage.status)}`}
      className={cn(
        "w-[300px] overflow-hidden rounded-app border bg-card shadow-app",
        stageBorderClass(stage.status),
      )}
    >
      <Handle
        className="!size-2.5 !border-2 !border-card"
        isConnectable={false}
        position={Position.Left}
        style={{ background: stageStatusColor(stage.status) }}
        type="target"
      />
      <header className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <StageStatusIcon status={stage.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-[12px] font-semibold text-foreground">
              {stage.name}
            </h2>
            <StatusBadge status={stage.status} />
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            Stage {stage.stageIndex + 1}
            {agentId ? ` · ${agentId}` : ""}
            {stage.attempt > 0 ? ` · Attempt ${stage.attempt}` : ""}
          </p>
        </div>
      </header>
      <div className="grid gap-1.5 p-2">
        {stage.prompts.map((prompt) => (
          <div
            key={prompt.promptIndex}
            className="flex min-w-0 items-start gap-2 rounded-app-sm border border-app-border-faint bg-muted px-2 py-1.5"
          >
            <TurnStatusIcon status={prompt.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium text-muted-foreground">
                  Turn {prompt.promptIndex + 1}
                </span>
                <span className="text-[9px] text-muted-foreground">
                  {turnStatusLabel(prompt.status)}
                  {prompt.runCount > 0 ? ` · ${prompt.runCount}x` : ""}
                </span>
              </div>
              <p
                className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-foreground"
                title={prompt.title}
              >
                {prompt.title}
              </p>
              {prompt.outputSchema ? (
                <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">
                  output: {prompt.outputSchema}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <footer className="flex justify-end border-t border-border px-2 py-2">
        <Button
          className="nodrag nopan"
          disabled={runDisabled}
          icon={stage.attempt > 0 ? RotateCcw : Play}
          loading={runLoading}
          onClick={() => onRunStage(stage.stageIndex)}
          size="sm"
          title={stage.attempt > 0 ? "Run this Stage again" : "Run this Stage"}
          type="button"
          variant={stage.attempt > 0 ? "outline" : "primary"}
        >
          {stage.attempt > 0 ? "Run again" : "Run Stage"}
        </Button>
      </footer>
      <Handle
        className="!size-2.5 !border-2 !border-card"
        isConnectable={false}
        position={Position.Right}
        style={{ background: stageStatusColor(stage.status) }}
        type="source"
      />
    </article>
  );
}

function allowNodeInteractions() {
  // React Flow only enables pointer events for a read-only node when it has
  // an interaction handler. The Stage button remains the only mutable action.
}

function StageStatusIcon({ status }: { status: WorkflowStageStatus }) {
  const Icon =
    status === "completed"
      ? CheckCircle2
      : status === "failed"
        ? XCircle
        : status === "running"
          ? LoaderCircle
          : CircleDashed;
  return (
    <Icon
      className={cn(
        "mt-0.5 size-4 shrink-0",
        status === "running" ? "animate-spin" : "",
      )}
      style={{ color: stageStatusColor(status) }}
    />
  );
}

function TurnStatusIcon({ status }: { status: WorkflowTurnStatus }) {
  const Icon =
    status === "completed"
      ? Check
      : status === "failed"
        ? X
        : status === "running"
          ? LoaderCircle
          : Circle;
  return (
    <Icon
      className={cn(
        "mt-0.5 size-3 shrink-0",
        status === "running" ? "animate-spin" : "",
      )}
      style={{ color: stageStatusColor(status) }}
    />
  );
}

function StatusBadge({ status }: { status: WorkflowStageStatus }) {
  return (
    <Badge className="px-1 py-0 text-[9px]" tone={stageStatusTone(status)}>
      {stageStatusLabel(status)}
    </Badge>
  );
}

function workflowNodes(
  workflow: WorkflowDefinition,
  stages: readonly WorkflowStageProgress[],
  agents: readonly string[],
  {
    onRunStage,
    runDisabled,
    runningStageIndex,
  }: {
    onRunStage: (stageIndex: number) => void;
    runDisabled: boolean;
    runningStageIndex?: number;
  },
): SessionWorkflowNode[] {
  const positionByName = workflowNodePositions(workflow);
  return stages.map((stage) => ({
    id: stage.nodeId,
    type: "workflowStage",
    position: positionByName.get(stage.nodeId) ?? {
      x: stage.stageIndex * 360,
      y: 0,
    },
    data: {
      agentId: agents[stage.stageIndex],
      onRunStage,
      runDisabled,
      runLoading: runningStageIndex === stage.stageIndex,
      stage,
    },
    draggable: false,
    selectable: false,
  }));
}

function workflowEdges(
  workflow: WorkflowDefinition,
  stages: readonly WorkflowStageProgress[],
): Edge[] {
  const progressByName = new Map(stages.map((stage) => [stage.nodeId, stage]));
  return workflow.stages.flatMap((targetStage) =>
    (targetStage.dependsOn ?? []).flatMap((dependency) => {
      const source = progressByName.get(dependency);
      const target = progressByName.get(targetStage.name);
      if (!source || !target) return [];
      const color =
        target.status !== "pending"
          ? stageStatusColor(target.status)
          : source.status === "completed" || source.status === "failed"
            ? stageStatusColor(source.status)
            : "var(--border-strong)";
      return {
        id: `${source.nodeId}->${target.nodeId}`,
        source: source.nodeId,
        target: target.nodeId,
        type: "smoothstep",
        animated: target.status === "running",
        markerEnd: { color, type: MarkerType.ArrowClosed },
        selectable: false,
        style: { stroke: color, strokeWidth: 1.5 },
      };
    }),
  );
}

function shouldPollWorkflowStatus(
  value:
    | {
        status: AuditStatus;
        workflowState: WorkflowStateSnapshot;
      }
    | undefined,
) {
  if (!value) return true;
  return (
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "interrupted" &&
    value.workflowState.status !== "completed" &&
    value.workflowState.status !== "failed"
  );
}

function stageStatusColor(status: WorkflowStageStatus) {
  return {
    completed: "var(--success)",
    failed: "var(--danger)",
    partial: "var(--warning)",
    pending: "var(--text-faint)",
    running: "var(--info)",
  }[status];
}

function stageBorderClass(status: WorkflowStageStatus) {
  return {
    completed: "border-app-success-border",
    failed: "border-app-danger-border",
    partial: "border-app-warning-border",
    pending: "border-border",
    running: "border-app-info-border ring-2 ring-app-info/10",
  }[status];
}

function stageStatusTone(status: WorkflowStageStatus): BadgeTone {
  return (
    {
      completed: "success",
      failed: "danger",
      partial: "warning",
      pending: "muted",
      running: "info",
    } as const
  )[status];
}

function stageStatusLabel(status: WorkflowStageStatus) {
  return {
    completed: "Completed",
    failed: "Failed",
    partial: "Partially completed",
    pending: "Pending",
    running: "Running",
  }[status];
}

function turnStatusLabel(status: WorkflowTurnStatus) {
  return {
    completed: "Completed",
    failed: "Failed",
    pending: "Pending",
    running: "Running",
  }[status];
}
