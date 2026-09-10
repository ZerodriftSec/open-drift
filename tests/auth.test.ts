import {
  isGoogleEmailAllowed,
  parseGoogleEmailAllowlist,
} from "@/lib/auth/google-email-allowlist";
import { isAuthenticationRequired } from "@/lib/auth/config";
import { isPlatformTokenAuthorized } from "@/lib/auth/platform-token";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";
import { describe, expect, test } from "vitest";

describe("authentication requirement", () => {
  test("is disabled by default and for non-true values", () => {
    expect(isAuthenticationRequired()).toBe(false);
    expect(isAuthenticationRequired("false")).toBe(false);
    expect(isAuthenticationRequired("1")).toBe(false);
  });

  test("is enabled only by an explicit true value", () => {
    expect(isAuthenticationRequired("true")).toBe(true);
    expect(isAuthenticationRequired(" TRUE ")).toBe(true);
  });
});

describe("Google email allowlist", () => {
  test("normalizes, trims, and deduplicates configured emails", () => {
    expect([
      ...parseGoogleEmailAllowlist(
        " Admin@Example.com, user@example.com,admin@example.com ",
      ),
    ]).toEqual(["admin@example.com", "user@example.com"]);
  });

  test("matches emails case-insensitively", () => {
    expect(isGoogleEmailAllowed("ADMIN@example.com", "admin@example.com")).toBe(
      true,
    );
  });

  test("fails closed when the allowlist is empty", () => {
    expect(isGoogleEmailAllowed("admin@example.com", "")).toBe(false);
  });

  test("rejects malformed allowlist entries", () => {
    expect(() => parseGoogleEmailAllowlist("not-an-email")).toThrow();
  });
});

describe("safe redirect paths", () => {
  test("keeps local paths with query strings", () => {
    expect(safeRedirectPath("/sessions?page=2")).toBe("/sessions?page=2");
  });

  test("rejects protocol-relative and absolute URLs", () => {
    expect(safeRedirectPath("//example.com/path")).toBe("/sessions");
    expect(safeRedirectPath("https://example.com/path")).toBe("/sessions");
  });
});

describe("platform token authorization", () => {
  const platformToken = "a".repeat(64);

  test("accepts the configured token as a Bearer credential", () => {
    expect(
      isPlatformTokenAuthorized(`Bearer ${platformToken}`, platformToken),
    ).toBe(true);
  });

  test("rejects missing, malformed, and incorrect credentials", () => {
    expect(isPlatformTokenAuthorized(null, platformToken)).toBe(false);
    expect(isPlatformTokenAuthorized(platformToken, platformToken)).toBe(false);
    expect(
      isPlatformTokenAuthorized(`Bearer ${"b".repeat(64)}`, platformToken),
    ).toBe(false);
    expect(isPlatformTokenAuthorized(`Bearer ${platformToken}`, "")).toBe(
      false,
    );
  });
});
