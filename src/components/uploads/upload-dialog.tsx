"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import type { AuditAgentDefinition } from "@/audit/agent/registry";
import type { WorkflowDefinitionSummary } from "@/server/workflows";
import {
  defaultStageAgentIds,
  StageAgentSelects,
} from "@/app/components/agents/stage-agent-selects";
import { WorkflowSelect } from "@/app/components/workflows/workflow-select";
import { errorMessage, requestJson } from "@/app/components/lib/api-client";
import { useApiMutation } from "@/app/components/lib/use-api-mutation";
import { Button } from "@/app/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/app/components/ui/dialog";
import { Field, Input, Textarea } from "@/app/components/ui/field";
import { cn } from "@/app/components/ui/cn";
import { DEFAULT_TASK_SOURCE } from "@/lib/task-metadata";
import {
  createLocalPathSession,
  createUploadBackedSession,
  type CreatedSession,
} from "@/components/uploads/session-launch";

type UploadDialogProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  uploadError?: string;
};

type Mode = "local" | "session";

const agentsResponseSchema = z.object({
  agents: z.array(
    z
      .object({
        api: z.enum(["glm", "deepseek"]).optional(),
        available: z.boolean(),
        displayName: z.string(),
        id: z.string(),
        model: z.string(),
        provider: z.enum(["claude", "codex", "gemini"]),
        reasoningEffort: z
          .enum(["no", "low", "medium", "high", "ultra", "xhigh", "max"])
          .optional(),
      })
      .passthrough(),
  ),
});

const workflowsResponseSchema = z.object({
  defaultWorkflowId: z.string(),
  workflows: z.array(
    z
      .object({
        category: z.string().optional(),
        id: z.string(),
        label: z.string(),
        stageCount: z.number().int().nonnegative(),
        stageIds: z.array(z.string()),
        source: z.enum(["code", "file"]),
      })
      .passthrough(),
  ),
});

export function UploadDialog({
  onOpenChange,
  open,
  uploadError,
}: UploadDialogProps) {
  const [mode, setMode] = useState<Mode>(uploadError ? "session" : "local");
  const optionsQuery = useQuery({
    enabled: open,
    queryFn: loadCreateSessionOptions,
    queryKey: ["create-session-options"],
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md">
      <DialogHeader
        title="Create audit task"
        description="Select a local project path or a single-project ZIP archive."
        onClose={() => onOpenChange(false)}
      />

      <div className="flex shrink-0 items-center gap-0.5 border-b border-app-border bg-app-surface-muted px-3 py-1.5">
        <ModeTab
          active={mode === "local"}
          onClick={() => setMode("local")}
          icon={FolderOpen}
        >
          Local path
        </ModeTab>
        <ModeTab
          active={mode === "session"}
          onClick={() => setMode("session")}
          icon={Upload}
        >
          Single-project ZIP
        </ModeTab>
      </div>

      <DialogBody>
        {optionsQuery.data ? (
          mode === "local" ? (
            <LocalPathForm
              agentOptions={optionsQuery.data.agentOptions}
              defaultWorkflowId={optionsQuery.data.defaultWorkflowId}
              workflowOptions={optionsQuery.data.workflowOptions}
              onSuccess={() => onOpenChange(false)}
            />
          ) : (
            <SessionUploadForm
              agentOptions={optionsQuery.data.agentOptions}
              defaultWorkflowId={optionsQuery.data.defaultWorkflowId}
              workflowOptions={optionsQuery.data.workflowOptions}
              error={uploadError}
              onSuccess={() => onOpenChange(false)}
            />
          )
        ) : optionsQuery.error ? (
          <div className="grid min-h-32 place-items-center gap-3 text-center">
            <FormError>{errorMessage(optionsQuery.error)}</FormError>
            <Button
              onClick={() => void optionsQuery.refetch()}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : (
          <div className="grid min-h-32 place-items-center text-app-text-muted">
            <span className="inline-flex items-center gap-2 text-[12px]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading Agents and Workflows
            </span>
          </div>
        )}
      </DialogBody>
    </Dialog>
  );
}

export function CreateSessionButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        className={className}
        icon={Upload}
        onClick={() => setOpen(true)}
        variant="primary"
      >
        Create task
      </Button>
      <UploadDialog onOpenChange={setOpen} open={open} />
    </>
  );
}

async function loadCreateSessionOptions() {
  const [agentsResponse, workflowsResponse] = await Promise.all([
    requestJson(
      "/api/agents",
      {},
      agentsResponseSchema,
      "Failed to load Agent options",
    ),
    requestJson(
      "/api/workflows",
      {},
      workflowsResponseSchema,
      "Failed to load Workflow options",
    ),
  ]);

  return {
    agentOptions: agentsResponse.agents as AuditAgentDefinition[],
    defaultWorkflowId: workflowsResponse.defaultWorkflowId,
    workflowOptions: workflowsResponse.workflows,
  };
}

function ModeTab({
  active,
  children,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-app-sm px-2.5 text-[12px] font-medium transition-colors",
        active
          ? "bg-app-surface text-app-text shadow-app"
          : "text-app-text-muted hover:text-app-text",
      )}
    >
      <Icon className="h-3 w-3" />
      {children}
    </button>
  );
}

function LocalPathForm({
  agentOptions,
  defaultWorkflowId,
  workflowOptions,
  onSuccess,
}: {
  agentOptions: AuditAgentDefinition[];
  defaultWorkflowId: string;
  workflowOptions: WorkflowDefinitionSummary[];
  onSuccess: () => void;
}) {
  const router = useRouter();
  const createMutation = useApiMutation<CreatedSession, FormData>({
    invalidateKeys: [["sessions"]],
    mutationFn: (formData) =>
      createLocalPathSession(
        formData,
        agentAssignmentsForWorkflow(
          workflowOptions,
          selectedWorkflowId,
          selectedAgentIds,
        ),
      ),
    onSuccess: (result) => {
      onSuccess();
      router.push(result.redirectTo);
    },
    successMessage: (result) => result.message,
  });
  const busy = createMutation.isPending;
  const formError = createMutation.error
    ? errorMessage(createMutation.error)
    : undefined;
  const [selectedAgentIds, setSelectedAgentIds] = useState(() =>
    defaultStageAgentIds(agentOptions, workflowOptions, defaultWorkflowId),
  );
  const [selectedWorkflowId, setSelectedWorkflowId] =
    useState(defaultWorkflowId);
  const [submittingRun, setSubmittingRun] = useState<boolean | null>(null);

  function selectWorkflow(workflowId: string) {
    setSelectedWorkflowId(workflowId);
    setSelectedAgentIds(
      defaultStageAgentIds(agentOptions, workflowOptions, workflowId),
    );
  }

  function submitSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.reset();
    const submission = getSessionSubmission(event);
    setSubmittingRun(submission.run);
    createMutation.mutate(submission.formData);
  }

  return (
    <form
      action="/api/sessions"
      className="grid gap-3"
      method="post"
      onSubmit={submitSession}
      aria-busy={busy || undefined}
    >
      <Field label="Workflow">
        <WorkflowSelect
          name="workflowId"
          onChange={selectWorkflow}
          value={selectedWorkflowId}
          workflows={workflowOptions}
        />
      </Field>
      <Field label="Agent" hint="Select one Agent for each Workflow Stage.">
        <StageAgentSelects
          agents={agentOptions}
          agentIds={selectedAgentIds}
          onChange={setSelectedAgentIds}
        />
      </Field>
      <Field
        label="Task source"
        hint={`Records where the task originated; defaults to ${DEFAULT_TASK_SOURCE}`}
      >
        <Input
          name="queueSource"
          defaultValue={DEFAULT_TASK_SOURCE}
          placeholder="internal"
          required
          type="text"
        />
      </Field>
      <Field
        label="Project name"
        hint="Optional; defaults to the directory name"
      >
        <Input
          name="projectName"
          defaultValue="mock"
          placeholder="white-eagle"
          type="text"
        />
      </Field>
      <Field
        label="Local project path"
        hint="Relative paths resolve from the application root; the directory must exist"
      >
        <Input
          name="source"
          defaultValue="mock"
          placeholder="mock"
          required
          type="text"
        />
      </Field>
      <Field label="Metadata" hint="Optional JSON object">
        <Textarea name="metadata" placeholder='{"requestId":"req-001"}' />
      </Field>
      {formError ? <FormError>{formError}</FormError> : null}
      <div className="flex justify-end gap-2">
        <Button
          type="submit"
          name="run"
          value="true"
          variant="primary"
          icon={FolderOpen}
          loading={busy && submittingRun !== false}
          disabled={busy}
        >
          Create and run
        </Button>
        <Button
          type="submit"
          name="run"
          value="false"
          variant="outline"
          loading={busy && submittingRun === false}
          disabled={busy}
        >
          Create only
        </Button>
      </div>
    </form>
  );
}

function SessionUploadForm({
  agentOptions,
  defaultWorkflowId,
  workflowOptions,
  error,
  onSuccess,
}: {
  agentOptions: AuditAgentDefinition[];
  defaultWorkflowId: string;
  workflowOptions: WorkflowDefinitionSummary[];
  error?: string;
  onSuccess: () => void;
}) {
  const router = useRouter();
  const createMutation = useApiMutation<CreatedSession, FormData>({
    invalidateKeys: [["sessions"]],
    mutationFn: (formData) =>
      createUploadBackedSession(
        formData,
        agentAssignmentsForWorkflow(
          workflowOptions,
          selectedWorkflowId,
          selectedAgentIds,
        ),
      ),
    onSuccess: (result) => {
      onSuccess();
      router.push(result.redirectTo);
    },
    successMessage: (result) => result.message,
  });
  const busy = createMutation.isPending;
  const formError = createMutation.error
    ? errorMessage(createMutation.error)
    : error;
  const [selectedAgentIds, setSelectedAgentIds] = useState(() =>
    defaultStageAgentIds(agentOptions, workflowOptions, defaultWorkflowId),
  );
  const [selectedWorkflowId, setSelectedWorkflowId] =
    useState(defaultWorkflowId);
  const [submittingRun, setSubmittingRun] = useState<boolean | null>(null);

  function selectWorkflow(workflowId: string) {
    setSelectedWorkflowId(workflowId);
    setSelectedAgentIds(
      defaultStageAgentIds(agentOptions, workflowOptions, workflowId),
    );
  }

  function submitSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.reset();
    const submission = getSessionSubmission(event);
    setSubmittingRun(submission.run);
    createMutation.mutate(submission.formData);
  }

  return (
    <form
      action="/api/sessions"
      className="grid gap-3"
      encType="multipart/form-data"
      method="post"
      onSubmit={submitSession}
      aria-busy={busy || undefined}
    >
      <Field label="Workflow">
        <WorkflowSelect
          name="workflowId"
          onChange={selectWorkflow}
          value={selectedWorkflowId}
          workflows={workflowOptions}
        />
      </Field>
      <Field label="Agent" hint="Select one Agent for each Workflow Stage.">
        <StageAgentSelects
          agents={agentOptions}
          agentIds={selectedAgentIds}
          onChange={setSelectedAgentIds}
        />
      </Field>
      <Field
        label="Project name"
        hint="Optional; defaults to the ZIP filename without its extension"
      >
        <Input name="projectName" placeholder="white-eagle" type="text" />
      </Field>
      <Field
        label="Task source"
        hint={`Records where the task originated; defaults to ${DEFAULT_TASK_SOURCE}`}
      >
        <Input
          name="queueSource"
          defaultValue={DEFAULT_TASK_SOURCE}
          placeholder="internal"
          required
          type="text"
        />
      </Field>
      <Field label="Project ZIP archive">
        <input
          accept=".zip,application/zip,application/x-zip-compressed"
          name="archive"
          required
          type="file"
          className={cn(
            "block w-full text-[12px] text-app-text-muted",
            "file:mr-2 file:inline-flex file:h-7 file:items-center file:rounded-app-sm file:border file:border-app-border file:bg-app-surface file:px-2 file:text-[12px] file:font-medium file:text-app-primary hover:file:bg-app-hover",
          )}
        />
      </Field>
      <Field label="Metadata" hint="Optional JSON object">
        <Textarea name="metadata" placeholder='{"requestId":"req-001"}' />
      </Field>
      {formError ? <FormError>{formError}</FormError> : null}
      <div className="flex justify-end gap-2">
        <Button
          type="submit"
          name="run"
          value="true"
          variant="primary"
          icon={Upload}
          loading={busy && submittingRun !== false}
          disabled={busy}
        >
          Create and run
        </Button>
        <Button
          type="submit"
          name="run"
          value="false"
          variant="outline"
          loading={busy && submittingRun === false}
          disabled={busy}
        >
          Create only
        </Button>
      </div>
    </form>
  );
}

function getSessionSubmission(event: FormEvent<HTMLFormElement>) {
  const submitter = (event.nativeEvent as SubmitEvent).submitter;
  const run = !(
    submitter instanceof HTMLButtonElement && submitter.value === "false"
  );
  const formData = new FormData(event.currentTarget);
  formData.set("run", String(run));

  return { formData, run };
}

function agentAssignmentsForWorkflow(
  workflows: WorkflowDefinitionSummary[],
  workflowId: string,
  agentIds: string[],
) {
  const stageIds = workflows.find(
    (workflow) => workflow.id === workflowId,
  )?.stageIds;
  if (!stageIds || stageIds.length !== agentIds.length) {
    throw new Error(
      "The Workflow Stages do not match the selected Agents. Select the Workflow again.",
    );
  }

  return Object.fromEntries(
    stageIds.map((stageId, index) => [stageId, agentIds[index]!] as const),
  );
}

function FormError({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-app-sm border border-app-danger-border bg-app-danger-bg px-2 py-1.5 text-[12px] text-app-danger">
      {children}
    </div>
  );
}
