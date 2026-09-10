"use client";

import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/components/ui/cn";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

type MetadataEntry = [string, unknown];

export function MetadataSummaryLine({ entries }: { entries: MetadataEntry[] }) {
  const entriesRef = useRef<HTMLDListElement>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [collapseHeight, setCollapseHeight] = useState<number>();

  const measureRows = useCallback(() => {
    const container = entriesRef.current;
    if (!container) return;

    const containerTop = container.getBoundingClientRect().top;
    const rowTops: number[] = [];

    for (const child of container.children) {
      const top = child.getBoundingClientRect().top - containerTop;
      if (rowTops.every((rowTop) => Math.abs(rowTop - top) > 1)) {
        rowTops.push(top);
      }
    }

    const thirdRowTop = rowTops[2];
    setCollapseHeight(thirdRowTop);
  }, []);

  useLayoutEffect(() => {
    const container = entriesRef.current;
    if (!container) return;

    measureRows();
    const observer = new ResizeObserver(measureRows);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measureRows]);

  const isCollapsible = collapseHeight !== undefined;

  return (
    <section className="grid gap-1.5 py-2 md:grid-cols-[72px_minmax(0,1fr)]">
      <div className="pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
        Additional information
      </div>
      <div className="min-w-0">
        <dl
          className={cn(
            "flex min-w-0 flex-wrap gap-x-4 gap-y-1.5",
            collapsed && isCollapsible && "overflow-hidden",
          )}
          ref={entriesRef}
          style={
            collapsed && isCollapsible
              ? { maxHeight: `${collapseHeight}px` }
              : undefined
          }
        >
          {entries.map(([key, value]) => (
            <div
              className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-[12px] leading-tight"
              key={key}
            >
              <dt className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-app-text-muted">
                {key}
              </dt>
              <dd className="min-w-0 break-all font-semibold text-app-text">
                <MetadataValue value={value} />
              </dd>
            </div>
          ))}
        </dl>
        {isCollapsible ? (
          <Button
            aria-expanded={!collapsed}
            className="-ml-2.5 mt-0.5"
            icon={collapsed ? ChevronDown : ChevronUp}
            onClick={() => setCollapsed((current) => !current)}
            size="sm"
            variant="link"
          >
            {collapsed ? "Expand" : "Collapse"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function MetadataValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    if (isHttpUrl(value)) {
      return (
        <a
          className="text-app-primary underline decoration-app-primary/30 underline-offset-2 hover:decoration-app-primary"
          href={value}
          rel="noreferrer"
          target="_blank"
        >
          {value}
        </a>
      );
    }

    return value;
  }

  return formatMetadataValue(value);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatMetadataValue(value: unknown) {
  if (value === null) {
    return "null";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}
