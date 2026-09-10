"use client";

import { FileJson2, Save, Trash2, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiMutation } from "@/components/lib/use-api-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { WorkflowDefinitionViewer } from "@/components/workflows/workflow-definition-viewer";
import type { WorkflowDocumentRecord } from "@/server/workflows";

export function WorkflowJsonEditor({
  initialWorkflow,
}: {
  initialWorkflow: WorkflowDocumentRecord;
}) {
  const router = useRouter();
  const [content, setContent] = useState(() =>
    JSON.stringify(initialWorkflow.document, null, 2),
  );
  const [workflowDocument, setWorkflowDocument] = useState(
    initialWorkflow.document,
  );
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const saveMutation = useApiMutation<WorkflowDocumentRecord, string>({
    invalidateKeys: [["workflows"], ["workflow", initialWorkflow.id]],
    mutationFn: async (nextContent) => {
      const document = parseWorkflowJson(nextContent);
      const response = await fetch(
        `/api/workflows/${encodeURIComponent(initialWorkflow.id)}`,
        {
          body: JSON.stringify(document),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      );
      const body = (await response.json().catch(() => ({}))) as
        WorkflowDocumentRecord | { error?: string };
      if (!response.ok || !("document" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Unable to save Workflow JSON.",
        );
      }
      return body;
    },
    onSuccess: (saved) => {
      setContent(JSON.stringify(saved.document, null, 2));
      setWorkflowDocument(saved.document);
    },
    refresh: false,
    successMessage: "Workflow JSON saved.",
  });
  const deleteMutation = useApiMutation<{ deleted: true }, void>({
    invalidateKeys: [["workflows"]],
    mutationFn: async () => {
      const response = await fetch(
        `/api/workflows/${encodeURIComponent(initialWorkflow.id)}`,
        { method: "DELETE" },
      );
      const body = (await response.json().catch(() => ({}))) as {
        deleted?: boolean;
        error?: string;
      };
      if (!response.ok || body.deleted !== true) {
        throw new Error(body.error ?? "Unable to delete Workflow JSON.");
      }
      return { deleted: true };
    },
    onSuccess: () => {
      setDeleteDialogOpen(false);
      router.push("/workflows");
    },
    refresh: false,
    successMessage: `Workflow "${initialWorkflow.document.name}" deleted.`,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto grid w-full max-w-7xl gap-3">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <FileJson2 className="size-4 shrink-0 text-primary" />
              <h1 className="truncate text-[15px] font-semibold">
                {initialWorkflow.document.name}
              </h1>
              <Badge tone={initialWorkflow.readOnly ? "muted" : "primary"}>
                {initialWorkflow.readOnly ? "Built-in read-only" : "JSON file"}
              </Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {initialWorkflow.readOnly
                ? "Built-in project definition; view only."
                : `.data/workflow/${initialWorkflow.id}.json`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button href="/workflows" variant="outline">
              Back to list
            </Button>
            {!initialWorkflow.readOnly ? (
              <>
                <Button
                  icon={Trash2}
                  variant="danger"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  Delete
                </Button>
                <Button
                  icon={Save}
                  loading={saveMutation.isPending}
                  variant="primary"
                  onClick={() => saveMutation.mutate(content)}
                >
                  Validate and save
                </Button>
              </>
            ) : null}
          </div>
        </header>

        <section className="overflow-hidden rounded-app border border-border bg-card shadow-app">
          <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Workflow className="size-3.5 shrink-0 text-primary" />
              <h2 className="truncate text-[13px] font-semibold">
                Workflow diagram
              </h2>
              <Badge tone="muted">
                {workflowDocument.stages.length} Stage
                {workflowDocument.stages.length === 1 ? "" : "s"}
              </Badge>
            </div>
            <span className="text-[10px] text-muted-foreground">
              Saved definition
            </span>
          </header>
          <div className="h-[26rem] md:h-[28rem]">
            <WorkflowDefinitionViewer stages={workflowDocument.stages} />
          </div>
        </section>

        <section className="grid min-h-[32rem] grid-rows-[auto_minmax(32rem,1fr)] overflow-hidden rounded-app border border-border bg-card shadow-app">
          <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <FileJson2 className="size-3.5 shrink-0 text-primary" />
              <h2 className="truncate text-[13px] font-semibold">
                Definition JSON
              </h2>
            </div>
            <span className="text-[10px] text-muted-foreground">
              {initialWorkflow.readOnly ? "Read-only" : "Editable"}
            </span>
          </header>
          <textarea
            aria-label="Workflow JSON"
            className="h-full min-h-[32rem] resize-none border-0 bg-card p-4 font-mono text-[12px] leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-ring/20 disabled:bg-muted"
            readOnly={initialWorkflow.readOnly}
            spellCheck={false}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </section>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogHeader
          title="Delete Workflow JSON"
          description="The file will be permanently deleted. Frozen Workflow snapshots in existing Sessions are unaffected."
          onClose={() => setDeleteDialogOpen(false)}
        />
        <DialogBody>
          <p className="text-[13px]">
            Delete &quot;{initialWorkflow.document.name}&quot;?
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={deleteMutation.isPending}
            variant="outline"
            onClick={() => setDeleteDialogOpen(false)}
          >
            Cancel
          </Button>
          <Button
            loading={deleteMutation.isPending}
            variant="destructive"
            onClick={() => deleteMutation.mutate()}
          >
            Delete permanently
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function parseWorkflowJson(content: string) {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${message}`);
  }
}
