"use client";

import { formatCalendarDateTime, formatDate } from "@/lib/format";
import type { ComponentProps } from "react";
import { useCallback, useSyncExternalStore } from "react";

type DateTimeValue = string | number | Date;

function subscribeToBrowserTimeZone() {
  return () => {};
}

export function LocalDateTimeText({
  fallback = "—",
  relativeDay = false,
  value,
}: {
  fallback?: string;
  relativeDay?: boolean;
  value?: DateTimeValue;
}) {
  const getSnapshot = useCallback(
    () => (relativeDay ? formatCalendarDateTime(value) : formatDate(value)),
    [relativeDay, value],
  );
  const getServerSnapshot = useCallback(() => fallback, [fallback]);

  return useSyncExternalStore(
    subscribeToBrowserTimeZone,
    getSnapshot,
    getServerSnapshot,
  );
}

export function LocalDateTime({
  fallback,
  relativeDay,
  value,
  ...props
}: Omit<ComponentProps<"time">, "children" | "dateTime"> & {
  fallback?: string;
  relativeDay?: boolean;
  value?: DateTimeValue;
}) {
  return (
    <time {...props} dateTime={isoDateTime(value)}>
      <LocalDateTimeText
        fallback={fallback}
        relativeDay={relativeDay}
        value={value}
      />
    </time>
  );
}

function isoDateTime(value?: DateTimeValue) {
  if (value === undefined) return undefined;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
