"use client";

import { ListMinus, RotateCcw, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import type { AuditAgentDefinition } from "@/audit/agent/registry";
import type { WorkflowDefinitionSummary } from "@/server/workflows";
import {
  defaultStageAgentIds,
  StageAgentSelects,
} from "@/app/components/agents/stage-agent-selects";
import { WorkflowSelect } from "@/app/components/workflows/workflow-select";
import {
  emptyResponseSchema,
  requestJson,
} from "@/app/components/lib/api-client";
import { useApiMutation } from "@/app/components/lib/use-api-mutation";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "@/app/components/ui/dialog";
import { Field } from "@/app/components/ui/field";

const rerunSessionResponseSchema = z
  .object({
    workflowId: z.string().optional(),
    backupDir: z.string().optional(),
    redirectTo: z.string().optional(),
    sessionId: z.string().min(1),
  })
  .passthrough();

const stopSessionResponseSchema = z
  .object({
    message: z.string(),
    sessionId: z.string().min(1),
  })
  .passthrough();

const dequeueSessionResponseSchema = z
  .object({
    message: z.string(),
    sessionId: z.string().min(1),
    status: z.literal("wait"),
  })
  .passthrough();

export function SessionDequeueButton({ sessionId }: { sessionId: string }) {
  const dequeueMutation = useApiMutation({
    invalidateKeys: [
      ["sessions"],
      ["session-status", sessionId],
      ["session-workflow-status", sessionId],
    ],
    mutationFn: () =>
      requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/dequeue`,
        { method: "POST" },
        dequeueSessionResponseSchema,
        "Failed to dequeue Session",
      ),
    successMessage: (result) => result.message,
  });

  return (
    <Button
      icon={ListMinus}
      loading={dequeueMutation.isPending}
      onClick={() => dequeueMutation.mutate()}
      size="sm"
      title="Dequeue"
      type="button"
      variant="secondary"
    >
      Dequeue
    </Button>
  );
}

export function SessionStopButton({ sessionId }: { sessionId: string }) {
  const stopMutation = useApiMutation({
    invalidateKeys: [
      ["sessions"],
      ["session-status", sessionId],
      ["session-workflow-status", sessionId],
    ],
    mutationFn: () =>
      requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
        { method: "POST" },
        stopSessionResponseSchema,
        "Failed to interrupt Session",
      ),
    successMessage: (result) => result.message,
  });

  return (
    <Button
      icon={Square}
      loading={stopMutation.isPending}
      onClick={() => stopMutation.mutate()}
      size="sm"
      title="Interrupt Session"
      type="button"
      variant="danger"
    >
      Interrupt
    </Button>
  );
}

export function SessionDeleteButton({
  disabled = false,
  redirectTo = "/",
  sessionId,
}: {
  disabled?: boolean;
  redirectTo?: string;
  sessionId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const deleteMutation = useApiMutation({
    invalidateKeys: [["sessions"], ["batches"]],
    mutationFn: () =>
      requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
        emptyResponseSchema,
        "Failed to delete Session",
      ),
    onSuccess: () => {
      setOpen(false);
      router.push(redirectTo);
    },
    successMessage: `Deleted ${sessionId}`,
  });
  const busy = deleteMutation.isPending;

  return (
    <>
      <Button
        disabled={busy || disabled}
        icon={Trash2}
        onClick={() => {
          deleteMutation.reset();
          setOpen(true);
        }}
        size="sm"
        title={
          disabled ? "A running Session cannot be deleted" : "Delete Session"
        }
        type="button"
        variant="danger"
      >
        Delete
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          if (next) deleteMutation.reset();
          setOpen(next);
        }}
        size="sm"
      >
        <DialogHeader
          title="Delete Session"
          description={`Delete the state, logs, and artifacts for Session ${sessionId}.`}
          onClose={() => !busy && setOpen(false)}
        />
        <DialogBody>
          <p className="m-0 text-[13px] text-app-text-secondary">
            This action cannot be undone. Continue?
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={Trash2}
            loading={busy}
            onClick={() => deleteMutation.mutate()}
          >
            Delete
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

export function SessionRerunButton({
  agentOptions,
  currentAgentIds,
  currentWorkflowId,
  disabled = false,
  sessionId,
  workflowOptions,
}: {
  agentOptions: AuditAgentDefinition[];
  currentAgentIds?: readonly string[];
  currentWorkflowId: string;
  disabled?: boolean;
  sessionId: string;
  workflowOptions: WorkflowDefinitionSummary[];
}) {
  const router = useRouter();
  const originalStageAgentIds = () =>
    stageAgentIdsForRerun({
      agentOptions,
      currentAgentIds,
      currentWorkflowId,
      workflowOptions,
    });
  const [selectedAgentIds, setSelectedAgentIds] = useState(() =>
    originalStageAgentIds(),
  );
  const [selectedWorkflowId, setSelectedWorkflowId] =
    useState(currentWorkflowId);
  const [open, setOpen] = useState(false);
  const rerunMutation = useApiMutation({
    invalidateKeys: [["sessions"]],
    mutationFn: () =>
      requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/rerun`,
        {
          json: {
            agentIds: selectedAgentIds,
            workflowId: selectedWorkflowId,
          },
          method: "POST",
        },
        rerunSessionResponseSchema,
        "Failed to rerun Session",
      ),
    onSuccess: (result) => {
      setOpen(false);
      router.push(
        result.redirectTo ??
          `/sessions/${encodeURIComponent(result.sessionId)}`,
      );
    },
    successMessage: "Session cleared and rerun",
  });
  const busy = rerunMutation.isPending;

  function selectWorkflow(workflowId: string) {
    setSelectedWorkflowId(workflowId);
    setSelectedAgentIds(
      defaultStageAgentIds(agentOptions, workflowOptions, workflowId),
    );
  }

  return (
    <>
      <Button
        disabled={busy || disabled}
        icon={RotateCcw}
        onClick={() => {
          rerunMutation.reset();
          setSelectedWorkflowId(currentWorkflowId);
          setSelectedAgentIds(originalStageAgentIds());
          setOpen(true);
        }}
        size="sm"
        title={disabled ? "A running Session cannot be rerun" : "Rerun Session"}
        type="button"
        variant="secondary"
      >
        Rerun
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          if (next) rerunMutation.reset();
          setOpen(next);
        }}
        size="sm"
      >
        <DialogHeader
          title="Rerun Session"
          description={`Back up the current directory for Session ${sessionId}, clear its state, and rerun it with the same ID.`}
          onClose={() => !busy && setOpen(false)}
        />
        <DialogBody>
          <Field label="Workflow">
            <WorkflowSelect
              disabled={busy}
              onChange={selectWorkflow}
              value={selectedWorkflowId}
              workflows={workflowOptions}
            />
          </Field>
          <Field label="Agent" hint="Select one Agent for each Workflow Stage.">
            <StageAgentSelects
              agents={agentOptions}
              agentIds={selectedAgentIds}
              disabled={busy}
              onChange={setSelectedAgentIds}
            />
          </Field>
          <p className="m-0 text-[13px] text-app-text-secondary">
            The current Session&apos;s old logs, Findings, and working directory
            will be moved to a backup directory. The page will continue using
            the same Session ID.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={RotateCcw}
            loading={busy}
            onClick={() => rerunMutation.mutate()}
          >
            Rerun
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function stageAgentIdsForRerun({
  agentOptions,
  currentAgentIds,
  currentWorkflowId,
  workflowOptions,
}: {
  agentOptions: AuditAgentDefinition[];
  currentAgentIds?: readonly string[];
  currentWorkflowId: string;
  workflowOptions: WorkflowDefinitionSummary[];
}) {
  const stageCount = workflowOptions.find(
    (workflow) => workflow.id === currentWorkflowId,
  )?.stageCount;

  const savedAgentIds = Array.isArray(currentAgentIds) ? currentAgentIds : [];

  if (stageCount === savedAgentIds.length && stageCount > 0) {
    return [...savedAgentIds];
  }

  return defaultStageAgentIds(agentOptions, workflowOptions, currentWorkflowId);
}
