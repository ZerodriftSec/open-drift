import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Tooltip({
  children,
  className,
  content,
  side = "top",
}: {
  children: ReactNode;
  className?: string;
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  if (!content) return <>{children}</>;

  const sideClasses = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  }[side];

  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 hidden whitespace-nowrap rounded-app-sm border border-border bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground shadow-app-strong group-hover/tip:block",
          sideClasses,
        )}
      >
        {content}
      </span>
    </span>
  );
}
