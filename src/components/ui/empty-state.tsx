import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  children,
  className,
  icon: Icon,
  title,
}: {
  children?: ReactNode;
  className?: string;
  icon?: LucideIcon;
  title: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid min-h-32 place-items-center rounded-app border border-app-border-faint bg-card px-6 py-8 text-center",
        className,
      )}
    >
      <div className="grid justify-items-center gap-1.5">
        {Icon ? (
          <Icon
            className="h-5 w-5 text-muted-foreground"
            aria-hidden="true"
            strokeWidth={1.5}
          />
        ) : null}
        <h2 className="m-0 text-[13px] font-semibold text-card-foreground">
          {title}
        </h2>
        {children ? (
          <p className="m-0 text-[12px] text-muted-foreground">{children}</p>
        ) : null}
      </div>
    </div>
  );
}
