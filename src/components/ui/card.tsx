import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type CardVariant = "default" | "flat" | "raised";

export const cardVariants = cva(
  "overflow-hidden rounded-app border text-card-foreground transition-[border-color,box-shadow] duration-150",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "border-border bg-card shadow-app",
        flat: "border-app-border-faint bg-muted",
        raised: "border-border bg-card shadow-app-overlay",
      } satisfies Record<CardVariant, string>,
    },
  },
);

export function Card({
  children,
  className,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
} & VariantProps<typeof cardVariants>) {
  return (
    <section
      data-slot="card"
      className={cn(cardVariants({ className, variant }))}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  action,
  children,
  className,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "flex min-h-10 items-center justify-between gap-3 border-b border-border px-3 py-2",
        className,
      )}
    >
      <div className="min-w-0 text-[13px] font-semibold text-card-foreground">
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="card-content" className={cn("p-3", className)}>
      {children}
    </div>
  );
}

export const CardBody = CardContent;
