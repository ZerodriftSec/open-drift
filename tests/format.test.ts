import { expect, test } from "vitest";
import { formatCalendarDateTime, formatDate } from "@/lib/format";

test("formats dates in the runtime local time zone", () => {
  const date = new Date("2026-08-05T00:30:00.000Z");

  expect(formatDate(date)).toBe(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "short",
    }).format(date),
  );
});

test("labels today's and yesterday's timestamps in English", () => {
  const now = new Date(2026, 7, 11, 12, 0);

  expect(formatCalendarDateTime(new Date(2026, 7, 11, 8, 5), now)).toBe(
    "Today 08:05",
  );
  expect(formatCalendarDateTime(new Date(2026, 7, 10, 23, 45), now)).toBe(
    "Yesterday 23:45",
  );
});

test("keeps the date for timestamps before yesterday", () => {
  const now = new Date(2026, 7, 11, 12, 0);
  const value = new Date(2026, 7, 9, 8, 5);

  expect(formatCalendarDateTime(value, now)).toBe(formatDate(value));
});
