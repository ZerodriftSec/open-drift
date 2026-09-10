"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Flag, MessageSquareText, Workflow } from "lucide-react";
import { useMemo } from "react";
import type { WorkflowStage, WorkflowTurn } from "@/audit/workflow";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { workflowNodePositions } from "@/lib/workflow-graph";

type WorkflowDefinitionNodeData = {
  stage: WorkflowStage;
  stageIndex: number;
};

type WorkflowDefinitionNode = Node<
  WorkflowDefinitionNodeData,
  "workflowDefinitionStage"
>;

const nodeTypes = {
  workflowDefinitionStage: WorkflowDefinitionStageNode,
};

export function WorkflowDefinitionViewer({
  stages,
}: {
  stages: readonly WorkflowStage[];
}) {
  const nodes = useMemo(() => workflowNodes(stages), [stages]);
  const edges = useMemo(() => workflowEdges(stages), [stages]);

  return (
    <section
      aria-label="Read-only Workflow definition graph"
      className="relative h-full min-h-0 min-w-0 bg-app-canvas"
    >
      <ReactFlow<WorkflowDefinitionNode, Edge>
        edges={edges}
        edgesReconnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        maxZoom={1.5}
        minZoom={0.25}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={nodeTypes}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          color="rgba(55, 53, 47, 0.11)"
          gap={18}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
      {nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">
          This Workflow has no Stages
        </div>
      ) : null}
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-app border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow-app backdrop-blur">
        Pan, zoom, and fit the view · Definition is read-only
      </div>
    </section>
  );
}

function WorkflowDefinitionStageNode({
  data,
}: NodeProps<WorkflowDefinitionNode>) {
  const { stage, stageIndex } = data;
  const threadMode = stage.threadMode ?? "new";

  return (
    <article
      aria-label={`${stage.name}, ${stage.turns.length} Turns`}
      className="w-[300px] overflow-hidden rounded-app border border-app-primary-border bg-card shadow-app"
    >
      <Handle
        className="!size-2.5 !border-2 !border-card !bg-primary"
        isConnectable={false}
        position={Position.Left}
        type="target"
      />
      <header className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-app-sm bg-app-primary-bg text-primary">
          <Workflow className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-[12px] font-semibold text-foreground">
              {stage.name}
            </h2>
            <Badge
              className="px-1 py-0 text-[9px]"
              tone={threadModeTone(threadMode)}
            >
              {threadModeLabel(threadMode)}
            </Badge>
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            Stage {stageIndex + 1} · {stage.turns.length} Turn
            {stage.turns.length === 1 ? "" : "s"}
          </p>
        </div>
      </header>

      <div className="nowheel grid max-h-[240px] gap-1.5 overflow-y-auto p-2">
        {stage.turns.map((turn, turnIndex) => {
          const metadata = turnMetadata(turn);
          return (
            <div
              key={turnIndex}
              className="flex min-w-0 items-start gap-2 rounded-app-sm border border-app-border-faint bg-muted px-2 py-1.5"
            >
              <MessageSquareText
                className="mt-0.5 size-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium text-muted-foreground">
                    Turn {turnIndex + 1}
                  </span>
                  {turn.goal ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-primary">
                      <Flag className="size-2.5" aria-hidden="true" />
                      Goal
                    </span>
                  ) : null}
                </div>
                <p
                  className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-foreground"
                  title={workflowTurnTitle(turn)}
                >
                  {workflowTurnTitle(turn)}
                </p>
                {metadata ? (
                  <p
                    className="mt-1 truncate font-mono text-[9px] text-muted-foreground"
                    title={metadata}
                  >
                    {metadata}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {(stage.dependsOn?.length ?? 0) > 0 ? (
        <footer className="truncate border-t border-border px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
          after: {stage.dependsOn!.join(", ")}
        </footer>
      ) : null}
      <Handle
        className="!size-2.5 !border-2 !border-card !bg-primary"
        isConnectable={false}
        position={Position.Right}
        type="source"
      />
    </article>
  );
}

function workflowNodes(
  stages: readonly WorkflowStage[],
): WorkflowDefinitionNode[] {
  const positionByName = workflowNodePositions({ stages });
  return stages.map((stage, stageIndex) => ({
    id: stage.name,
    type: "workflowDefinitionStage",
    position: positionByName.get(stage.name) ?? { x: stageIndex * 360, y: 0 },
    data: { stage, stageIndex },
    draggable: false,
    selectable: false,
  }));
}

function workflowEdges(stages: readonly WorkflowStage[]): Edge[] {
  const stageNames = new Set(stages.map((stage) => stage.name));
  return stages.flatMap((targetStage) =>
    (targetStage.dependsOn ?? []).flatMap((sourceStageName) => {
      if (!stageNames.has(sourceStageName)) return [];
      return {
        id: `${sourceStageName}->${targetStage.name}`,
        source: sourceStageName,
        target: targetStage.name,
        type: "smoothstep",
        markerEnd: {
          color: "var(--primary)",
          type: MarkerType.ArrowClosed,
        },
        selectable: false,
        style: { stroke: "var(--primary)", strokeWidth: 1.5 },
      };
    }),
  );
}

function workflowTurnTitle(turn: WorkflowTurn) {
  return turn.name?.trim() || turn.prompt.trim() || "Untitled Turn";
}

function turnMetadata(turn: WorkflowTurn) {
  return [
    turn.skills?.names?.length
      ? `${turn.skills.names.length} skill${turn.skills.names.length === 1 ? "" : "s"}`
      : undefined,
    turn.skills?.prefixes?.length
      ? `${turn.skills.prefixes.length} skill prefix${turn.skills.prefixes.length === 1 ? "" : "es"}`
      : undefined,
    turn.mcp?.length
      ? `${turn.mcp.length} MCP${turn.mcp.length === 1 ? "" : "s"}`
      : undefined,
    turn.outputSchema ? `output: ${turn.outputSchema}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function threadModeLabel(mode: NonNullable<WorkflowStage["threadMode"]>) {
  return {
    fork: "Fork",
    new: "New thread",
    resume: "Resume",
  }[mode];
}

function threadModeTone(
  mode: NonNullable<WorkflowStage["threadMode"]>,
): BadgeTone {
  return (
    {
      fork: "info",
      new: "primary",
      resume: "success",
    } as const satisfies Record<
      NonNullable<WorkflowStage["threadMode"]>,
      BadgeTone
    >
  )[mode];
}
