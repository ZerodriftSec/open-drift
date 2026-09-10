import * as z from "zod/v4";
import type { WorkflowDefinition } from ".";

export const workflowTurnStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);

export const workflowStageStatusSchema = z.enum([
  "pending",
  "running",
  "partial",
  "completed",
  "failed",
]);

export const workflowStatusSchema = z.enum([
  "idle",
  "running",
  "partial",
  "completed",
  "failed",
]);

export const workflowModeSchema = z.enum(["idle", "full", "manual"]);

export const workflowTurnStateSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  status: workflowTurnStatusSchema,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});

export const workflowStageStateSchema = z.object({
  stageIndex: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  status: workflowStageStatusSchema,
  threadId: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  turns: z.array(workflowTurnStateSchema),
});

export const workflowStateSchema = z.object({
  mode: workflowModeSchema,
  status: workflowStatusSchema,
  stages: z.array(workflowStageStateSchema),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  updatedAt: z.string(),
});

export type WorkflowTurnStatus = z.infer<typeof workflowTurnStatusSchema>;
export type WorkflowStageStatus = z.infer<typeof workflowStageStatusSchema>;
export type WorkflowStateSnapshot = z.infer<typeof workflowStateSchema>;

export function workflowProgress(state: WorkflowStateSnapshot) {
  const turns = state.stages.flatMap((stage) => stage.turns);
  const completedTurnCount = turns.filter(
    (turn) => turn.status === "completed",
  ).length;
  const turnCount = turns.length;

  return {
    completedTurnCount,
    percentage: turnCount === 0 ? 0 : (completedTurnCount / turnCount) * 100,
    turnCount,
  };
}

type PersistWorkflowState = (state: WorkflowStateSnapshot) => Promise<void>;

export class WorkflowState {
  private state: WorkflowStateSnapshot;
  private readonly persist: PersistWorkflowState;

  constructor(
    workflow: WorkflowDefinition,
    persist: PersistWorkflowState,
    initialState = createWorkflowStateSnapshot(workflow),
  ) {
    this.state = initialState;
    this.persist = persist;
  }

  toJSON() {
    return this.state;
  }

  async beginFullWorkflowExecution() {
    return this.commit(beginFullWorkflowExecution(this.state));
  }

  async beginStageAttempt(stageIndex: number) {
    return this.commit(beginStageAttempt(this.state, stageIndex));
  }

  async beginManualTurnExecution(stageIndex: number, turnIndex: number) {
    return this.commit(
      beginManualTurnExecution(this.state, stageIndex, turnIndex),
    );
  }

  async setStageThreadId(stageIndex: number, threadId: string) {
    return this.commit(
      setWorkflowStageThreadId(this.state, stageIndex, threadId),
    );
  }

  async markTurnRunning(stageIndex: number, turnIndex: number) {
    return this.commit(
      markWorkflowTurnRunning(this.state, stageIndex, turnIndex),
    );
  }

  async markTurnCompleted(stageIndex: number, turnIndex: number) {
    return this.commit(
      markWorkflowTurnCompleted(this.state, stageIndex, turnIndex),
    );
  }

  async markTurnFailed(stageIndex: number, turnIndex: number, error: unknown) {
    return this.commit(
      markWorkflowTurnFailed(this.state, stageIndex, turnIndex, error),
    );
  }

  async markStageCompleted(stageIndex: number) {
    return this.commit(markWorkflowStageCompleted(this.state, stageIndex));
  }

  async markStageFailed(stageIndex: number, error: unknown) {
    return this.commit(markWorkflowStageFailed(this.state, stageIndex, error));
  }

  async completeWorkflowExecution() {
    return this.commit(completeWorkflowExecution(this.state));
  }

  async failWorkflowExecution(error: unknown) {
    return this.commit(failWorkflowExecution(this.state, error));
  }

  private async commit(next: WorkflowStateSnapshot) {
    await this.persist(next);
    this.state = next;
    return next;
  }
}

export function createWorkflowStateSnapshot(
  workflow: WorkflowDefinition,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  return {
    mode: "idle",
    status: "idle",
    stages: workflow.stages.map((stage, stageIndex) => ({
      stageIndex,
      attempt: 0,
      status: "pending",
      turns: Array.from(stage.turns.keys(), (turnIndex) => ({
        turnIndex,
        runCount: 0,
        status: "pending",
      })),
    })),
    updatedAt: now,
  };
}

export function deserializeWorkflowStateSnapshot(
  serialized: string,
  workflow: WorkflowDefinition,
): WorkflowStateSnapshot {
  try {
    const parsed = workflowStateSchema.safeParse(JSON.parse(serialized));
    if (parsed.success) {
      return alignWorkflowStateToWorkflow(parsed.data, workflow);
    }
  } catch {
    // Invalid persisted state falls back to the Workflow snapshot.
  }

  return createWorkflowStateSnapshot(workflow);
}

function beginFullWorkflowExecution(
  state: WorkflowStateSnapshot,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  return {
    mode: "full",
    status: "running",
    stages: state.stages.map((stage) => ({
      stageIndex: stage.stageIndex,
      attempt: stage.attempt,
      status: "pending",
      turns: stage.turns.map((turn) => ({
        turnIndex: turn.turnIndex,
        runCount: turn.runCount,
        status: "pending",
      })),
    })),
    startedAt: now,
    updatedAt: now,
  };
}

function beginStageAttempt(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  return replaceStage(
    state,
    stageIndex,
    (stage) => ({
      stageIndex,
      attempt: stage.attempt + 1,
      status: "running",
      startedAt: now,
      turns: stage.turns.map((turn) => ({
        turnIndex: turn.turnIndex,
        runCount: turn.runCount,
        status: "pending",
      })),
    }),
    now,
  );
}

function beginManualTurnExecution(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  turnIndex: number,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  const stage = requiredStage(state, stageIndex);
  if (turnIndex > 0 && !stage.threadId) {
    throw new Error(
      `Workflow stage ${stageIndex} has no thread. Run its first turn first.`,
    );
  }

  const prepared =
    turnIndex === 0
      ? beginStageAttempt(
          resetWorkflowStagesAfter(state, stageIndex, now),
          stageIndex,
          now,
        )
      : state;
  return markWorkflowTurnRunning(
    {
      ...prepared,
      mode: "manual",
      status: "running",
      startedAt: prepared.startedAt ?? now,
      finishedAt: undefined,
      error: undefined,
      updatedAt: now,
    },
    stageIndex,
    turnIndex,
    now,
  );
}

function resetWorkflowStagesAfter(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  now: string,
): WorkflowStateSnapshot {
  requiredStage(state, stageIndex);
  return {
    ...state,
    stages: state.stages.map((stage) =>
      stage.stageIndex > stageIndex
        ? {
            stageIndex: stage.stageIndex,
            attempt: stage.attempt,
            status: "pending" as const,
            turns: stage.turns.map((turn) => ({
              turnIndex: turn.turnIndex,
              runCount: turn.runCount,
              status: "pending" as const,
            })),
          }
        : stage,
    ),
    updatedAt: now,
  };
}

function setWorkflowStageThreadId(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  threadId: string,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  return replaceStage(
    state,
    stageIndex,
    (stage) => ({ ...stage, threadId }),
    now,
  );
}

function markWorkflowTurnRunning(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  turnIndex: number,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  return replaceTurn(
    {
      ...state,
      status: "running",
      startedAt: state.startedAt ?? now,
      finishedAt: undefined,
      error: undefined,
    },
    stageIndex,
    turnIndex,
    (turn) => ({
      turnIndex,
      runCount: turn.runCount + 1,
      status: "running",
      startedAt: now,
    }),
    now,
  );
}

function markWorkflowTurnCompleted(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  turnIndex: number,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  const next = replaceTurn(
    state,
    stageIndex,
    turnIndex,
    (turn) => ({
      ...turn,
      status: "completed",
      finishedAt: now,
      error: undefined,
    }),
    now,
  );
  return withDerivedWorkflowStatus(next, now);
}

function markWorkflowTurnFailed(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  turnIndex: number,
  error: unknown,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  const message = errorMessage(error);
  const next = replaceTurn(
    state,
    stageIndex,
    turnIndex,
    (turn) => ({
      ...turn,
      status: "failed",
      finishedAt: now,
      error: message,
    }),
    now,
  );
  return {
    ...next,
    status: "failed",
    finishedAt: now,
    error: message,
    updatedAt: now,
  };
}

function markWorkflowStageCompleted(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  const next = replaceStage(
    state,
    stageIndex,
    (stage) => ({
      ...stage,
      status: "completed",
      finishedAt: now,
      error: undefined,
    }),
    now,
  );
  return withDerivedWorkflowStatus(next, now);
}

function markWorkflowStageFailed(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  error: unknown,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  const message = errorMessage(error);
  const next = replaceStage(
    state,
    stageIndex,
    (stage) => ({
      ...stage,
      status: "failed",
      finishedAt: now,
      error: message,
    }),
    now,
  );
  return {
    ...next,
    status: "failed",
    finishedAt: now,
    error: message,
    updatedAt: now,
  };
}

function completeWorkflowExecution(
  state: WorkflowStateSnapshot,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  return {
    ...state,
    status: "completed",
    finishedAt: now,
    error: undefined,
    updatedAt: now,
  };
}

function failWorkflowExecution(
  state: WorkflowStateSnapshot,
  error: unknown,
  now = new Date().toISOString(),
): WorkflowStateSnapshot {
  const message = errorMessage(error);
  return {
    ...state,
    status: "failed",
    finishedAt: now,
    error: message,
    updatedAt: now,
  };
}

function alignWorkflowStateToWorkflow(
  state: WorkflowStateSnapshot,
  workflow: WorkflowDefinition,
): WorkflowStateSnapshot {
  return {
    ...state,
    updatedAt: state.updatedAt || new Date().toISOString(),
    stages: workflow.stages.map((stage, stageIndex) => {
      const current = state.stages.find(
        (candidate) => candidate.stageIndex === stageIndex,
      );
      return {
        stageIndex,
        attempt: current?.attempt ?? 0,
        status: current?.status ?? "pending",
        ...(current?.threadId ? { threadId: current.threadId } : {}),
        ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
        ...(current?.finishedAt ? { finishedAt: current.finishedAt } : {}),
        ...(current?.error ? { error: current.error } : {}),
        turns: Array.from(stage.turns.keys(), (turnIndex) => {
          const turn = current?.turns.find(
            (candidate) => candidate.turnIndex === turnIndex,
          );
          return {
            turnIndex,
            runCount: turn?.runCount ?? 0,
            status: turn?.status ?? "pending",
            ...(turn?.startedAt ? { startedAt: turn.startedAt } : {}),
            ...(turn?.finishedAt ? { finishedAt: turn.finishedAt } : {}),
            ...(turn?.error ? { error: turn.error } : {}),
          };
        }),
      };
    }),
  };
}

function replaceStage(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  update: (
    stage: WorkflowStateSnapshot["stages"][number],
  ) => WorkflowStateSnapshot["stages"][number],
  now: string,
) {
  const stage = requiredStage(state, stageIndex);
  return {
    ...state,
    stages: state.stages.map((candidate) =>
      candidate.stageIndex === stageIndex ? update(stage) : candidate,
    ),
    updatedAt: now,
  };
}

function replaceTurn(
  state: WorkflowStateSnapshot,
  stageIndex: number,
  turnIndex: number,
  update: (
    turn: WorkflowStateSnapshot["stages"][number]["turns"][number],
  ) => WorkflowStateSnapshot["stages"][number]["turns"][number],
  now: string,
) {
  return replaceStage(
    state,
    stageIndex,
    (stage) => {
      const turn = stage.turns.find(
        (candidate) => candidate.turnIndex === turnIndex,
      );
      if (!turn) {
        throw new Error(
          `Workflow stage ${stageIndex} has no turn ${turnIndex}.`,
        );
      }
      const turns = stage.turns.map((candidate) =>
        candidate.turnIndex === turnIndex ? update(turn) : candidate,
      );
      return {
        ...stage,
        status: stageStatus(turns),
        startedAt: stage.startedAt ?? now,
        finishedAt: undefined,
        error: undefined,
        turns,
      };
    },
    now,
  );
}

function requiredStage(state: WorkflowStateSnapshot, stageIndex: number) {
  const stage = state.stages.find(
    (candidate) => candidate.stageIndex === stageIndex,
  );
  if (!stage) {
    throw new Error(`Workflow has no stage ${stageIndex}.`);
  }
  return stage;
}

function stageStatus(
  turns: WorkflowStateSnapshot["stages"][number]["turns"],
): WorkflowStageStatus {
  if (turns.some((turn) => turn.status === "failed")) return "failed";
  if (turns.some((turn) => turn.status === "running")) return "running";
  if (turns.length > 0 && turns.every((turn) => turn.status === "completed")) {
    return "completed";
  }
  if (turns.some((turn) => turn.status === "completed")) return "partial";
  return "pending";
}

function withDerivedWorkflowStatus(
  state: WorkflowStateSnapshot,
  now: string,
): WorkflowStateSnapshot {
  const status =
    state.stages.length > 0 &&
    state.stages.every((stage) => stage.status === "completed")
      ? "completed"
      : state.mode === "full"
        ? "running"
        : state.stages.some((stage) => stage.status === "failed")
          ? "failed"
          : state.stages.some((stage) => stage.status === "running")
            ? "running"
            : state.stages.some((stage) => stage.status !== "pending")
              ? "partial"
              : "idle";

  return {
    ...state,
    status,
    ...(status === "completed" || status === "failed"
      ? { finishedAt: now }
      : { finishedAt: undefined }),
    updatedAt: now,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
