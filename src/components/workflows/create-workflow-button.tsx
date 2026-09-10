"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiMutation } from "@/components/lib/use-api-mutation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import type { WorkflowDocumentRecord } from "@/server/workflows";

export function CreateWorkflowButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const createMutation = useApiMutation<WorkflowDocumentRecord, string>({
    invalidateKeys: [["workflows"]],
    mutationFn: async (nextContent) => {
      let document: unknown;
      try {
        document = JSON.parse(nextContent) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON: ${message}`);
      }

      const response = await fetch("/api/workflows", {
        body: JSON.stringify(document),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as
        WorkflowDocumentRecord | { error?: string };
      if (!response.ok || !("id" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Unable to create Workflow JSON.",
        );
      }
      return body;
    },
    onSuccess: (workflow) => {
      setOpen(false);
      setContent("");
      router.push(`/workflows/${encodeURIComponent(workflow.id)}`);
    },
    refresh: false,
    successMessage: "Workflow JSON created.",
  });

  return (
    <>
      <Button icon={Plus} variant="primary" onClick={() => setOpen(true)}>
        New Workflow
      </Button>
      <Dialog open={open} onOpenChange={setOpen} size="lg">
        <DialogHeader
          title="New Workflow JSON"
          description="Enter the complete definition. Once validated, it will be saved to .data/workflow."
          onClose={() => setOpen(false)}
        />
        <DialogBody className="grid gap-2">
          <textarea
            aria-label="New Workflow JSON"
            className="min-h-[28rem] resize-y rounded-app border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
            spellCheck={false}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            Every Skill name must exactly match the name declared in its
            SKILL.md file under the skills directory.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            loading={createMutation.isPending}
            variant="primary"
            onClick={() => createMutation.mutate(content)}
          >
            Validate and create
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
