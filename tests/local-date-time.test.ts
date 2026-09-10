import { LocalDateTime } from "@/components/ui/local-date-time";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

test("does not bake the server time zone into rendered HTML", () => {
  const value = "2026-08-05T00:30:00.000Z";
  const html = renderToStaticMarkup(createElement(LocalDateTime, { value }));

  expect(html).toBe(`<time dateTime="${value}">—</time>`);
});
