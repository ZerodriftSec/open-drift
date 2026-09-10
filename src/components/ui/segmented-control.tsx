import Link from "next/link";
import { cn } from "@/lib/utils";

export type SegmentedItem = {
  count?: number;
  href?: string;
  label: React.ReactNode;
  value: string;
};

export function SegmentedControl({
  className,
  items,
  value,
}: {
  className?: string;
  items: SegmentedItem[];
  value: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-app border border-border bg-muted p-0.5",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        const content = (
          <>
            <span className="truncate">{item.label}</span>
            {item.count !== undefined ? (
              <span
                className={cn(
                  "rounded-app-sm px-1 py-0 font-mono text-[10px] font-medium leading-[14px]",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </>
        );

        const baseClass = cn(
          "inline-flex h-6 items-center gap-1 rounded-app-sm border px-2 text-[12px] font-medium transition-colors",
          active
            ? "border-app-border-strong bg-app-active text-foreground shadow-app"
            : "border-transparent text-muted-foreground hover:text-foreground",
        );

        return item.href ? (
          <Link
            key={item.value}
            href={item.href}
            prefetch={false}
            className={baseClass}
            scroll={false}
          >
            {content}
          </Link>
        ) : (
          <span key={item.value} className={baseClass}>
            {content}
          </span>
        );
      })}
    </div>
  );
}
