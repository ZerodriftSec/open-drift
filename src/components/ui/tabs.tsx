import Link from "next/link";
import { cn } from "@/lib/utils";

export type TabItem = {
  count?: number;
  href?: string;
  label: React.ReactNode;
  value: string;
};

export function Tabs({
  className,
  items,
  value,
}: {
  className?: string;
  items: TabItem[];
  value: string;
}) {
  return (
    <nav
      data-slot="tabs-list"
      aria-label="Tabs"
      className={cn(
        "flex items-center gap-1 border-b border-border",
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
                  "rounded-app-sm px-1.5 py-0.5 font-mono text-[10px] font-medium",
                  active
                    ? "bg-app-primary-bg text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </>
        );

        const baseClass = cn(
          "-mb-px inline-flex h-8 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium transition-colors",
          active
            ? "border-primary text-primary"
            : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
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
    </nav>
  );
}
