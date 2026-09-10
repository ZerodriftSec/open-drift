"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/app/components/ui/button";
import { Tooltip } from "@/app/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function AgentIdCopyButton({
  agentId,
  className,
}: {
  agentId: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  async function copyAgentId(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!agentId) {
      return;
    }

    try {
      await writeClipboardText(agentId);
      setCopied(true);
      toast.success("Agent ID copied");
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Failed to copy Agent ID");
    }
  }

  return (
    <Tooltip content={copied ? "Copied" : "Copy ID"} side="left">
      <Button
        aria-label="Copy Agent ID"
        disabled={!agentId}
        icon={copied ? Check : Copy}
        onClick={(event) => void copyAgentId(event)}
        size="icon"
        title="Copy Agent ID"
        type="button"
        variant="secondary"
        className={cn("h-8 w-8", className)}
      />
    </Tooltip>
  );
}

async function writeClipboardText(value: string) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy command failed");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
