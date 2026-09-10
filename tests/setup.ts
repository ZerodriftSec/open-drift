import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, vi } from "vitest";

import { closeDb } from "@/server/db";
import { createAgentMock, resetAgentMocks } from "./mock-agent";

vi.mock(import("@/audit/agent/registry"), async (importOriginal) => {
  const registry = await importOriginal();
  return {
    ...registry,
    createAgent: createAgentMock,
  };
});

const sourceProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const originalMigrationsFolder = process.env.DRIZZLE_MIGRATIONS_FOLDER;
const originalWorkingDirectory = process.cwd();
const temporaryProjectRoot = await mkdtemp(
  path.join(tmpdir(), "zerodrift-agent-test-"),
);

process.chdir(temporaryProjectRoot);
process.env.DRIZZLE_MIGRATIONS_FOLDER = path.join(sourceProjectRoot, "drizzle");
process.env.ZERODRIFT_TEST_PROJECT_ROOT = temporaryProjectRoot;

beforeEach(() => {
  resetAgentMocks();
});

afterAll(async () => {
  try {
    await closeDb();
  } finally {
    process.chdir(originalWorkingDirectory);
    if (originalMigrationsFolder === undefined) {
      delete process.env.DRIZZLE_MIGRATIONS_FOLDER;
    } else {
      process.env.DRIZZLE_MIGRATIONS_FOLDER = originalMigrationsFolder;
    }
    delete process.env.ZERODRIFT_TEST_PROJECT_ROOT;
    await rm(temporaryProjectRoot, { force: true, recursive: true });
  }
});
