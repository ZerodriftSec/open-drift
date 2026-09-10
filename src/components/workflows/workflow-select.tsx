"use client";

import type { WorkflowDefinitionSummary } from "@/server/workflows";
import { Select } from "@/app/components/ui/select";

export function WorkflowSelect({
  className,
  disabled,
  name,
  onChange,
  size = "md",
  value,
  workflows,
}: {
  className?: string;
  disabled?: boolean;
  name?: string;
  onChange: (value: string) => void;
  size?: "sm" | "md";
  value: string;
  workflows: WorkflowDefinitionSummary[];
}) {
  return (
    <Select
      className={className}
      containerClassName="min-w-0 w-full"
      disabled={disabled}
      name={name}
      onChange={(event) => onChange(event.target.value)}
      options={workflows.map((workflow) => ({
        label: workflow.label,
        value: workflow.id,
      }))}
      size={size}
      value={value}
    />
  );
}
