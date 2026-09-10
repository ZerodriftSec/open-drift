import { cn } from "@/lib/utils";

type ProgressTone = "primary" | "success" | "warning" | "danger";

const toneClasses: Record<ProgressTone, string> = {
  primary: "bg-app-primary",
  success: "bg-app-success",
  warning: "bg-app-warning",
  danger: "bg-app-danger",
};

export function ProgressBar({
  className,
  tone = "primary",
  value,
}: {
  className?: string;
  tone?: ProgressTone;
  value: number;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = `${(clamped * 100).toFixed(1)}%`;

  return (
    <div
      data-slot="progress"
      className={cn(
        "h-1 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      role="progressbar"
      aria-valuenow={clamped * 100}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          "h-full rounded-full transition-[width] duration-200 ease-out",
          toneClasses[tone],
        )}
        style={{ width: pct }}
      />
    </div>
  );
}
