"use client";

import { Download } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/app/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "@/app/components/ui/dialog";

export function HumanConfirmedFindingsExportButton({
  compact = false,
  count,
  href,
}: {
  compact?: boolean;
  count: number;
  href: string;
}) {
  const [open, setOpen] = useState(false);

  if (count === 0) {
    return null;
  }

  function openConfirmation(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setOpen(true);
  }

  return (
    <>
      <Button
        aria-label={`Export ${count} Human Confirmed Findings`}
        className={
          compact
            ? "h-7 w-7 justify-self-end text-app-text-muted hover:text-app-text"
            : undefined
        }
        icon={Download}
        onClick={openConfirmation}
        size={compact ? "icon" : "sm"}
        title={`Export ${count} Human Confirmed Findings`}
        type="button"
        variant={compact ? "ghost" : "outline"}
      >
        {compact ? null : "Export Human Confirmed"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen} size="sm">
        <DialogHeader
          title="Export Human Confirmed Findings"
          description={`Export ${count} manually confirmed Findings as Markdown.`}
          onClose={() => setOpen(false)}
        />
        <DialogBody>
          <p className="m-0 text-[13px] text-app-text-secondary">
            Download the current Human Confirmed Findings?
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <a
            className={buttonVariants({ size: "sm", variant: "primary" })}
            download
            href={href}
            onClick={() => {
              setOpen(false);
              toast.success("Human Confirmed Findings download started");
            }}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Download</span>
          </a>
        </DialogFooter>
      </Dialog>
    </>
  );
}
