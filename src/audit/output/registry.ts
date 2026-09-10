import type pino from "pino";
import * as z from "zod/v4";
import type { AuditSession } from "@/audit/session";
import {
  duplicateFindingSchema,
  findingInputSchema,
  findingStructuredOutputItemSchema,
  onchainConfirmFindingSchema,
  reviewFindingSchema,
  type Finding,
} from "@/audit/session/types";
import { SessionFindingStatus } from "@/server/db/schema";
import type { WorkflowOutputSchemaName } from "./names";
import {
  captureSessionSourceManifest,
  parseFindingInput,
  validateFindingPaths,
} from "./finding-validation";

type OutputContext = {
  session: AuditSession;
  sourceManifest(): Promise<ReadonlySet<string>>;
};

type OutputRegistration<T> = {
  apply(item: T, context: OutputContext): Promise<Finding>;
  instruction: string;
  itemSchema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
};

function defineOutput<T>({
  apply,
  instruction,
  itemSchema,
  structuredOutputItemSchema = itemSchema,
}: Omit<OutputRegistration<T>, "jsonSchema"> & {
  structuredOutputItemSchema?: z.ZodType;
}): OutputRegistration<T> {
  return {
    apply,
    instruction,
    itemSchema,
    jsonSchema: z.toJSONSchema(z.array(structuredOutputItemSchema), {
      target: "draft-7",
    }) as Record<string, unknown>,
  };
}

export const workflowOutputRegistry = {
  "finding.submit": defineOutput({
    itemSchema: findingInputSchema,
    structuredOutputItemSchema: findingStructuredOutputItemSchema,
    instruction:
      "Return every candidate finding as an item in the final JSON array. Return [] when there are no candidate findings.",
    apply: async (item, context) => {
      const finding = await context.session.addFinding(
        await parseFindingInput(
          item,
          context.session.repoDirectoryPath,
          await context.sourceManifest(),
        ),
      );
      return requirePersistedFinding(finding, "Submitted finding");
    },
  }),
  "finding.submit-confirmed": defineOutput({
    itemSchema: findingInputSchema,
    structuredOutputItemSchema: findingStructuredOutputItemSchema,
    instruction:
      "Return every validated finding as an item in the final JSON array. Return [] when there are no validated findings.",
    apply: async (item, context) =>
      requirePersistedFinding(
        await context.session.addConfirmedFinding(
          await parseFindingInput(
            item,
            context.session.repoDirectoryPath,
            await context.sourceManifest(),
          ),
        ),
        "Submitted confirmed finding",
      ),
  }),
  "finding.duplicate": defineOutput({
    itemSchema: duplicateFindingSchema,
    instruction:
      "Return one mapping for each duplicate finding. finding_id is the duplicate row and duplicate_of_id is its canonical finding. Return [] when no duplicates should be marked.",
    apply: async (item, context) =>
      context.session.markDuplicateFinding(
        item.finding_id,
        item.duplicate_of_id,
      ),
  }),
  "finding.review": defineOutput({
    itemSchema: reviewFindingSchema,
    instruction:
      "Return only findings you reviewed. Each item must choose confirm or reject and include a concrete reason for that decision. Return [] when no findings were reviewed.",
    apply: async (item, context) => {
      if (item.decision === "reject") {
        return context.session.rejectFinding(item.finding_id, item.reason);
      }

      const confirmableFinding = (await context.session.readAllFindings()).find(
        (candidate) =>
          candidate.id === item.finding_id &&
          (candidate.status === SessionFindingStatus.PENDING ||
            candidate.status === SessionFindingStatus.CONFIRMED),
      );
      if (!confirmableFinding) {
        throw new Error(
          `Pending or confirmed finding not found: ${item.finding_id}`,
        );
      }
      await validateFindingPaths(
        confirmableFinding,
        context.session.repoDirectoryPath,
        await context.sourceManifest(),
      );
      return context.session.confirmFinding(item.finding_id, item.reason);
    },
  }),
  "finding.onchain-confirm": defineOutput({
    itemSchema: onchainConfirmFindingSchema,
    instruction:
      "Return one item for each pending finding proven by the fixed-block contract state. Return [] when no finding is proven on chain.",
    apply: async (item, context) =>
      context.session.onchainConfirmFinding(item.finding_id, {
        economic_impact: item.economic_impact,
        triggered_actor: item.triggered_actor,
        trigger_conditions: item.trigger_conditions,
      }),
  }),
} satisfies Record<
  WorkflowOutputSchemaName,
  OutputRegistration<never> | OutputRegistration<unknown>
>;

export type WorkflowOutputApplicationSummary = {
  failedCount: number;
  itemCount: number;
  succeededCount: number;
};

export function getWorkflowOutputDefinition(name: WorkflowOutputSchemaName) {
  return workflowOutputRegistry[name];
}

export function formatWorkflowOutputPrompt(
  prompt: string,
  name: WorkflowOutputSchemaName,
) {
  const registration = getWorkflowOutputDefinition(name);
  return `${prompt.trimEnd()}\n\nFinal output requirements:\n${registration.instruction}\nYour final response must be only the raw JSON array matching the supplied schema. Do not wrap it in Markdown or another object and do not call a finding tool.`;
}

export async function applyWorkflowOutput({
  logger,
  name,
  output,
  session,
}: {
  logger: pino.Logger;
  name: WorkflowOutputSchemaName;
  output: unknown;
  session: AuditSession;
}): Promise<WorkflowOutputApplicationSummary> {
  if (!Array.isArray(output)) {
    throw new Error(
      `Structured output ${name} must be a JSON array; received ${valueKind(output)}.`,
    );
  }

  const registration = getWorkflowOutputDefinition(
    name,
  ) as OutputRegistration<unknown>;
  let sourceManifestPromise: Promise<ReadonlySet<string>> | undefined;
  const context: OutputContext = {
    session,
    sourceManifest: () =>
      (sourceManifestPromise ??= captureSessionSourceManifest(session)),
  };
  let succeededCount = 0;
  const failures: string[] = [];

  for (const [itemIndex, rawItem] of output.entries()) {
    const parsed = registration.itemSchema.safeParse(rawItem);
    if (!parsed.success) {
      const error = formatZodError(parsed.error);
      failures.push(`item ${itemIndex}: ${error}`);
      logger.warn(
        { error, itemIndex, outputSchema: name },
        "finding_output_item_rejected",
      );
      continue;
    }

    try {
      const finding = await registration.apply(parsed.data, context);
      succeededCount += 1;
      logger.info(
        { findingId: finding.id, itemIndex, outputSchema: name },
        "finding_output_item_applied",
      );
      session.agentLogger.info("finding_changed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`item ${itemIndex}: ${message}`);
      logger.warn(
        { err: error, itemIndex, outputSchema: name },
        "finding_output_item_rejected",
      );
    }
  }

  const summary = {
    failedCount: failures.length,
    itemCount: output.length,
    succeededCount,
  };
  logger.info(
    { ...summary, outputSchema: name },
    "finding_output_application_completed",
  );

  if (output.length > 0 && succeededCount === 0) {
    throw new Error(
      `Structured output ${name} applied no items: ${failures.join("; ")}`,
    );
  }

  return summary;
}

function requirePersistedFinding(finding: Finding, label: string) {
  if (!finding.id) throw new Error(`${label} did not return a database id`);
  return finding;
}

function formatZodError(error: z.ZodError) {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "item"}: ${issue.message}`)
    .join(", ");
}

function valueKind(value: unknown) {
  if (value === null) return "null";
  return typeof value === "object" ? "object" : typeof value;
}

export { workflowOutputSchemaNames } from "./names";
export type { WorkflowOutputSchemaName } from "./names";
