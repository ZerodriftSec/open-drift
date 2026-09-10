import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";

import { testAgent } from "./mock-agent";
import { WorkflowOutputSchemaNameSchema } from "@/app/openapi";
import {
  applyWorkflowOutput,
  formatWorkflowOutputPrompt,
  getWorkflowOutputDefinition,
  workflowOutputSchemaNames,
} from "@/audit/output/registry";
import { AuditSession } from "@/audit/session";
import { Severity } from "@/audit/session/types";
import { SessionFindingStatus } from "@/server/db/schema";
import { deleteSessionStateFromDb } from "@/server/db/store";
import {
  getDefaultWorkflowId,
  getWorkflowDefinition,
} from "@/server/workflows";

const logger = pino({ enabled: false });

test("registers five raw-array finding output schemas and canonical prompts", () => {
  expect(workflowOutputSchemaNames).toEqual([
    "finding.submit",
    "finding.submit-confirmed",
    "finding.duplicate",
    "finding.review",
    "finding.onchain-confirm",
  ]);
  expect(WorkflowOutputSchemaNameSchema.options).toEqual(
    workflowOutputSchemaNames,
  );

  for (const name of workflowOutputSchemaNames) {
    const jsonSchema = getWorkflowOutputDefinition(name).jsonSchema;
    expect(jsonSchema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "array",
    });
    expect(undocumentedSchemaFields(jsonSchema)).toEqual([]);
    expect(schemaObjectsMissingRequiredProperties(jsonSchema)).toEqual([]);
    expect(formatWorkflowOutputPrompt("Review findings.", name)).toContain(
      "only the raw JSON array",
    );
  }

  expect(
    getWorkflowOutputDefinition("finding.submit").itemSchema.safeParse({
      ...findingInput("Nullable fields"),
      recommendation: null,
      source_locations: null,
      triggered_actor: null,
    }).success,
  ).toBe(true);
});

function undocumentedSchemaFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      undocumentedSchemaFields(item, `${path}[${index}]`),
    );
  }
  if (!value || typeof value !== "object") return [];

  const schema = value as Record<string, unknown>;
  const missing: string[] = [];
  const properties = schema.properties;
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    for (const [name, field] of Object.entries(properties)) {
      const fieldPath = `${path}.${name}`;
      const description =
        field && typeof field === "object"
          ? (field as Record<string, unknown>).description
          : undefined;
      if (typeof description !== "string" || !description.trim()) {
        missing.push(fieldPath);
      }
      missing.push(...undocumentedSchemaFields(field, fieldPath));
    }
  }

  for (const [name, nested] of Object.entries(schema)) {
    if (name === "properties") continue;
    missing.push(...undocumentedSchemaFields(nested, `${path}.${name}`));
  }
  return missing;
}

function schemaObjectsMissingRequiredProperties(
  value: unknown,
  path = "$",
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      schemaObjectsMissingRequiredProperties(item, `${path}[${index}]`),
    );
  }
  if (!value || typeof value !== "object") return [];

  const schema = value as Record<string, unknown>;
  const missing: string[] = [];
  const properties = schema.properties;
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter(
            (name): name is string => typeof name === "string",
          )
        : [],
    );
    for (const [name, field] of Object.entries(properties)) {
      if (!required.has(name)) missing.push(`${path}.${name}`);
      missing.push(
        ...schemaObjectsMissingRequiredProperties(field, `${path}.${name}`),
      );
    }
  }

  for (const [name, nested] of Object.entries(schema)) {
    if (name === "properties") continue;
    missing.push(
      ...schemaObjectsMissingRequiredProperties(nested, `${path}.${name}`),
    );
  }
  return missing;
}

test("applies every finding output lifecycle operation within its Session", async () => {
  const session = await createOutputTestSession("lifecycle");

  try {
    await apply(session, "finding.submit", [
      findingInput("Canonical finding"),
      findingInput("Rejected finding"),
      findingInput("Duplicate finding"),
      findingInput("On-chain finding"),
    ]);
    await apply(session, "finding.submit-confirmed", [
      findingInput("Direct confirmed finding"),
    ]);

    const byTitle = new Map(
      (await session.readAllFindings()).map((finding) => [
        finding.title,
        finding,
      ]),
    );
    const canonical = byTitle.get("Canonical finding")!;
    const rejected = byTitle.get("Rejected finding")!;
    const duplicate = byTitle.get("Duplicate finding")!;
    const onchain = byTitle.get("On-chain finding")!;

    await apply(session, "finding.review", [
      {
        decision: "confirm",
        finding_id: canonical.id,
        reason: "The vulnerable path is reachable.",
      },
      {
        decision: "reject",
        finding_id: rejected.id,
        reason: "The path is unreachable.",
      },
    ]);
    await apply(session, "finding.duplicate", [
      { duplicate_of_id: canonical.id, finding_id: duplicate.id },
    ]);
    await apply(session, "finding.onchain-confirm", [
      {
        economic_impact: "Funds can be lost.",
        finding_id: onchain.id,
        trigger_conditions: "The vulnerable path is reachable.",
        triggered_actor: "An unprivileged attacker.",
      },
    ]);

    expect(
      Object.fromEntries(
        (await session.readAllFindings()).map((finding) => [
          finding.title,
          finding,
        ]),
      ),
    ).toMatchObject({
      "Canonical finding": {
        confirmation_reason: "The vulnerable path is reachable.",
        status: SessionFindingStatus.CONFIRMED,
      },
      "Direct confirmed finding": {
        status: SessionFindingStatus.CONFIRMED,
      },
      "Duplicate finding": {
        duplicate_of_id: canonical.id,
        status: SessionFindingStatus.DUPLICATE,
      },
      "On-chain finding": {
        economic_impact: "Funds can be lost.",
        status: SessionFindingStatus.ONCHAIN_CONFIRMED,
        triggered_actor: "An unprivileged attacker.",
      },
      "Rejected finding": {
        rejection_reason: "The path is unreachable.",
        status: SessionFindingStatus.REJECTED,
      },
    });
  } finally {
    await cleanupSession(session);
  }
});

test("keeps item failures independent and fails a non-empty all-invalid list", async () => {
  const session = await createOutputTestSession("partial");

  try {
    const partial = await apply(session, "finding.submit", [
      findingInput("Valid finding"),
      { ...findingInput("Generated path"), file_path: "Generated.sol" },
      { title: "Missing required fields" },
    ]);
    expect(partial).toEqual({
      failedCount: 2,
      itemCount: 3,
      succeededCount: 1,
    });
    expect((await session.readAllFindings()).map(({ title }) => title)).toEqual(
      ["Valid finding"],
    );

    await expect(
      apply(session, "finding.review", [
        { decision: "confirm", finding_id: 999_999, reason: "Not present" },
      ]),
    ).rejects.toThrow("applied no items");
    expect(await apply(session, "finding.review", [])).toEqual({
      failedCount: 0,
      itemCount: 0,
      succeededCount: 0,
    });
  } finally {
    await cleanupSession(session);
  }
});

test("rejects an invalid top level before writing any finding", async () => {
  const session = await createOutputTestSession("top-level");

  try {
    await expect(
      apply(session, "finding.submit", { findings: [findingInput("Hidden")] }),
    ).rejects.toThrow("must be a JSON array");
    expect(await session.readAllFindings()).toEqual([]);
  } finally {
    await cleanupSession(session);
  }
});

test("rejects cross-Session finding IDs and invalid review transitions", async () => {
  const owner = await createOutputTestSession("owner");
  const other = await createOutputTestSession("other");

  try {
    await apply(owner, "finding.submit", [findingInput("Owned finding")]);
    const [ownedFinding] = await owner.readAllFindings();
    if (!ownedFinding) throw new Error("Expected an owned finding.");

    await expect(
      apply(other, "finding.review", [
        {
          decision: "confirm",
          finding_id: ownedFinding.id,
          reason: "This ID belongs to another Session.",
        },
      ]),
    ).rejects.toThrow("applied no items");

    await apply(owner, "finding.review", [
      {
        decision: "reject",
        finding_id: ownedFinding.id,
        reason: "The path is unreachable.",
      },
    ]);
    await expect(
      apply(owner, "finding.review", [
        {
          decision: "confirm",
          finding_id: ownedFinding.id,
          reason: "Trying an invalid transition.",
        },
      ]),
    ).rejects.toThrow("applied no items");
  } finally {
    await cleanupSession(owner);
    await cleanupSession(other);
  }
});

function apply(
  session: AuditSession,
  name: (typeof workflowOutputSchemaNames)[number],
  output: unknown,
) {
  return applyWorkflowOutput({ logger, name, output, session });
}

async function createOutputTestSession(label: string) {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), `zerodrift-output-${label}-`),
  );
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const workflow = await getWorkflowDefinition(await getDefaultWorkflowId());
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    projectName: `output-${label}`,
    targetPath: sourceDirectory,
    workflow,
  });
  await session.copySourceToWorkingDirectory();
  return Object.assign(session, { sourceDirectory });
}

function findingInput(title: string) {
  return {
    description: `${title} description`,
    file_path: "Vault.sol",
    impact: `${title} impact`,
    root_cause: `${title} root cause`,
    severity: Severity.HIGH,
    title,
    triggered_actor: "An unprivileged attacker",
  };
}

async function cleanupSession(
  session: AuditSession & { sourceDirectory: string },
) {
  await session.close();
  await deleteSessionStateFromDb(session.sessionId);
  await rm(session.sessionDirectoryPath, { force: true, recursive: true });
  await rm(session.sourceDirectory, { force: true, recursive: true });
}
