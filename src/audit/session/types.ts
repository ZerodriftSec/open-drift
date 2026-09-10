import type { Json } from "drizzle-orm";
import * as z from "zod/v4";
import type { SessionFindingStatus } from "@/server/db/schema";
import type { WorkflowDefinition } from "@/audit/workflow";
import type { WorkflowStateSnapshot } from "@/audit/workflow/status";

export enum Severity {
  INFO = "info",
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  CRITICAL = "critical",
}

export const AuditStatus = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
  WAIT: "wait",
} as const;
export type AuditStatus = (typeof AuditStatus)[keyof typeof AuditStatus];

export type FindingSourceLocation = {
  file: string;
  start_line: number;
  end_line?: number | null;
  snippet?: string | null;
};

export type FindingId = number;

export const HumanFindingStatus = {
  FP: "fp",
  TP: "tp",
} as const;

export type HumanFindingStatus =
  (typeof HumanFindingStatus)[keyof typeof HumanFindingStatus];

export type Finding = {
  id?: FindingId;
  session_id?: string;
  duplicate_of_id?: FindingId | null;
  title: string;
  severity: Severity;
  file_path: string;
  description: string;
  recommendation?: string | null;
  note?: string | null;
  human_status?: HumanFindingStatus | null;

  root_cause: string;
  impact: string;
  /** Conditions that make an on-chain-confirmed issue exploitable. */
  trigger_conditions?: string | null;
  /**
   * Actor that can trigger or exploit the issue, such as an external user,
   * administrator, other authorized role, or automated executor.
   */
  triggered_actor?: string | null;
  /** Estimated loss, affected value, or valuation method for an on-chain issue. */
  economic_impact?: string | null;
  /** Reason supplied when the AI confirms a candidate finding. */
  confirmation_reason?: string | null;
  /** Reason supplied when the AI rejects a candidate finding. */
  rejection_reason?: string | null;

  source_locations?: FindingSourceLocation[];
};

/** Converts mistakenly double-escaped Markdown line breaks into real ones. */
export function normalizeFindingMarkdownText(value: string) {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n");
}

export type OnchainConfirmation = {
  trigger_conditions: string;
  triggered_actor: string;
  economic_impact: string;
};

export const severityValues = [
  Severity.INFO,
  Severity.LOW,
  Severity.MEDIUM,
  Severity.HIGH,
  Severity.CRITICAL,
] as const;

export const DEFAULT_FINDING_REVIEW_MIN_SEVERITY = Severity.HIGH;
export type FindingReviewSeverity = `${Severity}`;

const findingReviewSeverityRanks: Record<FindingReviewSeverity, number> = {
  [Severity.INFO]: 0,
  [Severity.LOW]: 1,
  [Severity.MEDIUM]: 2,
  [Severity.HIGH]: 3,
  [Severity.CRITICAL]: 4,
};

export function isFindingAtOrAboveReviewSeverity(
  severity: FindingReviewSeverity,
  minimumSeverity: FindingReviewSeverity = DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
) {
  return (
    findingReviewSeverityRanks[severity] >=
    findingReviewSeverityRanks[minimumSeverity]
  );
}

export function findingReviewSeverityLabel(severity: FindingReviewSeverity) {
  return severity[0]!.toUpperCase() + severity.slice(1);
}

export const sourceLocationInputSchema = z.object({
  file: z
    .string()
    .min(1)
    .describe(
      "Project-relative path to the existing source file containing this evidence.",
    ),
  start_line: z
    .number()
    .int()
    .positive()
    .describe("One-based first line of the relevant source range."),
  end_line: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Optional one-based last line of the relevant source range; null when unknown.",
    ),
  snippet: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Optional source excerpt matching the referenced line range; null when unavailable.",
    ),
});

export const findingInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("Concise, specific title that identifies the finding."),
  description: z
    .string()
    .min(1)
    .describe(
      "Detailed explanation of the finding and how it can be triggered.",
    ),
  root_cause: z
    .string()
    .min(1)
    .describe("Underlying implementation flaw that causes the finding."),
  severity: z
    .enum(severityValues)
    .describe("Security severity: info, low, medium, high, or critical."),
  file_path: z
    .string()
    .min(1)
    .describe(
      "Project-relative path to an existing source file that provides primary evidence.",
    ),
  impact: z
    .string()
    .min(1)
    .describe("Concrete security consequence if the finding is exploited."),
  recommendation: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Actionable remediation for the finding, or null if unavailable.",
    ),
  triggered_actor: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Actor that can trigger or exploit the issue, or null if not identified.",
    ),
  source_locations: z
    .array(sourceLocationInputSchema)
    .nullable()
    .optional()
    .describe(
      "Precise source locations supporting the finding, or null if unavailable.",
    ),
});

export const findingStructuredOutputItemSchema = findingInputSchema
  .extend({
    source_locations: z
      .array(sourceLocationInputSchema.required())
      .nullable()
      .describe(
        "Precise source locations supporting the finding, or null if unavailable.",
      ),
  })
  .required();

export const duplicateFindingSchema = z.object({
  finding_id: z
    .number()
    .int()
    .positive()
    .describe(
      "Persisted numeric ID of the finding that should be marked as a duplicate.",
    ),
  duplicate_of_id: z
    .number()
    .int()
    .positive()
    .describe("Persisted numeric ID of the canonical finding."),
});

export const reviewFindingSchema = z.object({
  finding_id: z
    .number()
    .int()
    .positive()
    .describe("Persisted numeric ID of the finding being reviewed."),
  decision: z
    .enum(["confirm", "reject"])
    .describe(
      "Review decision: confirm a valid finding or reject an invalid finding.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .describe("Concrete evidence-based reason for the review decision."),
});

export const onchainConfirmFindingSchema = z.object({
  finding_id: z
    .number()
    .int()
    .positive()
    .describe(
      "Persisted numeric ID of the pending finding being confirmed on chain.",
    ),
  trigger_conditions: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Specific fixed-block conditions that make the finding exploitable.",
    ),
  triggered_actor: z
    .string()
    .trim()
    .min(1)
    .describe("Actor that can trigger the finding under those conditions."),
  economic_impact: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Estimated loss, affected value, or valuation method for the on-chain impact.",
    ),
});

export type FindingInput = z.infer<typeof findingInputSchema>;

export type StoredFinding = Finding & {
  id: FindingId;
  session_id: string;
  status: SessionFindingStatus;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = {
  [key: string]: JsonValue;
};

export type AuditSessionSnapshot = {
  agents: readonly string[];
  workflowState: WorkflowStateSnapshot;
  stageAgentAssignments?: Record<string, string>;
  sessionId: string;
  workflow: WorkflowDefinition;
  workflowId: string;
  projectName: string;
  status: AuditStatus;
  metadata?: Json;
  source?: string;
  projectRoot: string;
  targetPath: string;
  workingDirectory?: string;
  sessionDir: string;
  programLogFile: string;
  agentLogFile?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  findingCount: number;
  pendingFindingCount: number;
  /** AI confirmed findings at or above the configured AI Confirm severity threshold. */
  aiConfirmedFindingCount: number;
};
