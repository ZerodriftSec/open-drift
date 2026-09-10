"use client";

import { Trash2 } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { z } from "zod";
import { requestJson } from "@/app/components/lib/api-client";
import { useApiMutation } from "@/app/components/lib/use-api-mutation";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "@/app/components/ui/dialog";

const deleteSessionGroupResponseSchema = z.object({
  deleted: z.literal(true),
  deletedSessionIds: z.array(z.string()),
  groupId: z.string().min(1),
});

export function SessionGroupDeleteButton({
  disabled,
  groupId,
  groupName,
  sessionCount,
}: {
  disabled: boolean;
  groupId: string;
  groupName: string;
  sessionCount: number;
}) {
  const [open, setOpen] = useState(false);
  const deleteMutation = useApiMutation({
    invalidateKeys: [["sessions"]],
    mutationFn: () =>
      requestJson(
        `/api/session-groups/${encodeURIComponent(groupId)}`,
        { method: "DELETE" },
        deleteSessionGroupResponseSchema,
        "Failed to delete Session Group",
      ),
    onSuccess: () => setOpen(false),
    successMessage: `Deleted Group "${groupName}" and its ${sessionCount} Sessions`,
  });
  const busy = deleteMutation.isPending;

  function openConfirmation(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    deleteMutation.reset();
    setOpen(true);
  }

  return (
    <>
      <Button
        aria-label={`Delete Group ${groupName}`}
        className="h-7 w-7 text-app-text-muted hover:text-app-danger"
        disabled={busy || disabled}
        icon={Trash2}
        loading={busy}
        onClick={openConfirmation}
        size="icon"
        title={
          disabled
            ? "A Group with running Sessions cannot be deleted"
            : `Delete Group and its ${sessionCount} Sessions`
        }
        type="button"
        variant="ghost"
      />

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        size="sm"
      >
        <DialogHeader
          title="Delete Session Group"
          description={`Delete Group "${groupName}" and its ${sessionCount} Sessions.`}
          onClose={() => !busy && setOpen(false)}
        />
        <DialogBody>
          <p className="m-0 text-[13px] text-app-text-secondary">
            Session Their state, Findings, logs, working directories, and
            artifacts will be permanently deleted. This action cannot be undone.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={() => setOpen(false)}
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            icon={Trash2}
            loading={busy}
            onClick={() => deleteMutation.mutate()}
            variant="danger"
          >
            Delete Group and Sessions
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
