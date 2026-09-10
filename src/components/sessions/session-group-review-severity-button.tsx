"use client";

import { SlidersHorizontal } from "lucide-react";
import { useState, type ChangeEvent, type MouseEvent } from "react";
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
import { Select } from "@/app/components/ui/select";
import {
  findingReviewSeverityLabel,
  severityValues,
  type FindingReviewSeverity,
} from "@/audit/session/types";

const reviewSeveritySchema = z.enum(severityValues);
const updateResponseSchema = z.object({
  groupId: z.string().min(1),
  reviewMinSeverity: reviewSeveritySchema,
});
const reviewSeverityOptions = [...severityValues].reverse().map((severity) => ({
  label: `≥ ${findingReviewSeverityLabel(severity)}`,
  value: severity,
}));

export function SessionGroupReviewSeverityButton({
  groupId,
  groupName,
  value,
}: {
  groupId: string;
  groupName: string;
  value: FindingReviewSeverity;
}) {
  const [open, setOpen] = useState(false);
  const [selectedValue, setSelectedValue] = useState(value);
  const updateMutation = useApiMutation({
    invalidateKeys: [["sessions"]],
    mutationFn: (reviewMinSeverity: FindingReviewSeverity) =>
      requestJson(
        `/api/session-groups/${encodeURIComponent(groupId)}`,
        { json: { reviewMinSeverity }, method: "PATCH" },
        updateResponseSchema,
        "Failed to update the review threshold",
      ),
    onSuccess: () => setOpen(false),
    successMessage: (data) =>
      `Group "${groupName}" review threshold changed to ${findingReviewSeverityLabel(data.reviewMinSeverity)}`,
  });
  const busy = updateMutation.isPending;

  function openSettings(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    updateMutation.reset();
    setSelectedValue(value);
    setOpen(true);
  }

  function handleOpenChange(next: boolean) {
    if (busy) return;
    if (next) setSelectedValue(value);
    setOpen(next);
  }

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const parsed = reviewSeveritySchema.safeParse(event.currentTarget.value);
    if (parsed.success) setSelectedValue(parsed.data);
  }

  return (
    <>
      <Button
        aria-label={`Change the review severity threshold for Group ${groupName}`}
        className="h-7 w-7 text-app-text-muted hover:text-app-text"
        icon={SlidersHorizontal}
        onClick={openSettings}
        size="icon"
        title={`Change review threshold (currently ≥ ${findingReviewSeverityLabel(value)})`}
        type="button"
        variant="ghost"
      />

      <Dialog open={open} onOpenChange={handleOpenChange} size="sm">
        <DialogHeader
          title="Change Needs Review threshold"
          description={`Group "${groupName}"`}
          onClose={() => !busy && setOpen(false)}
        />
        <DialogBody className="grid gap-2.5">
          <label
            className="grid gap-1.5 text-[12px] font-medium text-app-text-secondary"
            htmlFor={`group-review-severity-${groupId}`}
          >
            Minimum severity
            <Select
              disabled={busy}
              id={`group-review-severity-${groupId}`}
              onChange={handleChange}
              options={reviewSeverityOptions}
              value={selectedValue}
            />
          </label>
          <p className="m-0 text-[11px] leading-relaxed text-app-text-muted">
            Findings at or above this severity that are not yet Human Confirmed
            or Rejected appear in the Needs Review list.
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
            disabled={selectedValue === value}
            loading={busy}
            onClick={() => updateMutation.mutate(selectedValue)}
            variant="primary"
          >
            Save
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
