import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone =
  | "muted"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | FindingSeverityBadgeTone;

type FindingSeverity = "critical" | "high" | "info" | "low" | "medium";
type FindingSeverityBadgeTone = `finding-${FindingSeverity}`;

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-app-sm border border-transparent px-1.5 py-0.5 text-[11px] font-medium leading-tight",
  {
    defaultVariants: {
      tone: "muted",
    },
    variants: {
      tone: {
        danger: "bg-app-danger-bg text-app-danger",
        "finding-critical": "bg-finding-critical-bg text-finding-critical",
        "finding-high": "bg-finding-high-bg text-finding-high",
        "finding-info": "bg-finding-info-bg text-finding-info",
        "finding-low": "bg-finding-low-bg text-finding-low",
        "finding-medium": "bg-finding-medium-bg text-finding-medium",
        info: "bg-app-info-bg text-app-info",
        muted: "bg-muted text-muted-foreground",
        primary: "bg-app-primary-bg text-primary",
        success: "bg-app-success-bg text-app-success",
        warning: "bg-app-warning-bg text-app-warning",
      } satisfies Record<BadgeTone, string>,
    },
  },
);

const dotToneClasses: Record<BadgeTone, string> = {
  muted: "bg-app-text-faint",
  primary: "bg-app-primary",
  success: "bg-app-success",
  warning: "bg-app-warning",
  danger: "bg-app-danger",
  "finding-critical": "bg-finding-critical",
  "finding-high": "bg-finding-high",
  "finding-info": "bg-finding-info",
  "finding-low": "bg-finding-low",
  "finding-medium": "bg-finding-medium",
  info: "bg-app-info",
};

const findingSeverityTones: Record<FindingSeverity, FindingSeverityBadgeTone> =
  {
    critical: "finding-critical",
    high: "finding-high",
    info: "finding-info",
    low: "finding-low",
    medium: "finding-medium",
  };

export function findingSeverityTone(severity: FindingSeverity) {
  return findingSeverityTones[severity];
}

export function Badge({
  children,
  className,
  dot = false,
  tone = "muted",
}: {
  children: ReactNode;
  className?: string;
  dot?: boolean;
} & VariantProps<typeof badgeVariants>) {
  const safeTone = tone ?? "muted";

  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ className, tone: safeTone }))}
    >
      {dot ? (
        <span
          className={cn("h-1.5 w-1.5 rounded-full", dotToneClasses[safeTone])}
          aria-hidden="true"
        />
      ) : null}
      {children}
    </span>
  );
}
