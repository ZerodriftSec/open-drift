import { parseFindingView } from "@/lib/dashboard-params";
import { expect, test } from "vitest";

test("keeps the all findings view when parsing dashboard search params", () => {
  expect(parseFindingView("all-findings")).toBe("all-findings");
});

test("keeps the needs review view when parsing dashboard search params", () => {
  expect(parseFindingView("needs-review")).toBe("needs-review");
});
