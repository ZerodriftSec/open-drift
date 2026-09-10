import type { RunSummary } from "@/server/sessions";

export function formatDate(value?: string | number | Date) {
  if (value === undefined || value === null) {
    return "n/a";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatCalendarDateTime(
  value?: string | number | Date,
  now = new Date(),
) {
  if (value === undefined || value === null) {
    return "n/a";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

  if (isSameCalendarDay(date, now)) {
    return `Today ${time}`;
  }

  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  );
  if (isSameCalendarDay(date, yesterday)) {
    return `Yesterday ${time}`;
  }

  return formatDate(date);
}

export function formatCost(value?: number) {
  if (typeof value !== "number") {
    return "n/a";
  }

  return `$${value.toFixed(4)}`;
}

export function formatTokens(value?: number) {
  if (typeof value !== "number") {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDuration(value?: number) {
  if (typeof value !== "number") {
    return "n/a";
  }

  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }

  const roundedTenthSeconds = Math.round(value / 100) / 10;

  if (roundedTenthSeconds < 60) {
    return `${roundedTenthSeconds.toFixed(1)}s`;
  }

  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function totalTokens(summary: RunSummary) {
  return [summary.inputTokens, summary.outputTokens].reduce<number>(
    (total, value) => total + (value ?? 0),
    0,
  );
}

function isSameCalendarDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
