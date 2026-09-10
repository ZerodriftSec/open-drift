import { z } from "zod";
import { findingNoteMaxLength } from "@/schemas/finding";

const JsonObjectSchema = z
  .record(z.string(), z.unknown())
  .describe("Arbitrary JSON object metadata.");

const IsoDateTimeSchema = z.string().describe("ISO 8601 timestamp.");

export const AuditStatusSchema = z
  .enum(["wait", "queued", "running", "completed", "failed", "interrupted"])
  .describe("Audit session lifecycle status.");

export const PublicProgressStatusSchema = z
  .enum(["queued", "running", "completed", "failed", "stopped"])
  .describe("Client-facing audit status.");

export const CompatAuditStatusSchema = z
  .enum(["queued", "running", "completed", "failure", "interrupted"])
  .describe("Legacy compatibility session lifecycle status.");

export const SeveritySchema = z
  .enum(["info", "low", "medium", "high", "critical"])
  .describe("Finding severity.");

export const WorkflowOutputSchemaNameSchema = z.enum([
  "finding.submit",
  "finding.submit-confirmed",
  "finding.duplicate",
  "finding.review",
  "finding.onchain-confirm",
]);

export const ErrorResponse = z.object({
  error: z.string().describe("Human-readable error message."),
});

export const ZerodriftApiError = z.object({
  code: z.string().describe("Stable machine-readable error code."),
  details: z
    .unknown()
    .optional()
    .describe("Optional structured error details."),
  message: z.string().describe("Human-readable error message."),
});

export const ZerodriftApiErrorResponse = z.object({
  error: ZerodriftApiError.describe("Structured ZeroDrift API error."),
  success: z.literal(false).describe("Always false for error responses."),
});

export const RedirectResponse = z
  .object({})
  .describe(
    "Empty response body. The Location header contains the target URL.",
  );

export const TextResponse = z.string().describe("Plain text response body.");

export const SystemVersionResponse = z.object({
  name: z.string().describe("System package name."),
  version: z.string().describe("Current system semantic version."),
});

export const PaginationQueryParams = z.object({
  page: z.number().int().positive().optional().describe("1-based page number."),
  pageSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Page size alias used by the UI."),
  per_page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Page size used by compatibility clients."),
});

export const SessionIdParams = z.object({
  sessionId: z.string().min(1).describe("Audit session ID."),
});

export const SessionStageParams = z.object({
  sessionId: z.string().min(1).describe("Audit session ID."),
  stageIndex: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based Workflow Stage index."),
});

export const SessionGroupIdParams = z.object({
  groupId: z.string().min(1).describe("Session Group ID."),
});

export const WorkflowIdParams = z.object({
  workflowId: z.string().min(1).describe("Stable Workflow ID."),
});

export const UploadIdParams = z.object({
  uploadId: z.string().min(1).describe("Upload ID."),
});

export const FindingSourceLocation = z.object({
  end_line: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Ending line number, 1-based."),
  file: z.string().describe("Repo-relative source file path."),
  snippet: z
    .string()
    .nullable()
    .optional()
    .describe("Optional source snippet."),
  start_line: z
    .number()
    .int()
    .positive()
    .describe("Starting line number, 1-based."),
});

export const Finding = z.object({
  description: z.string().describe("Detailed finding body."),
  duplicate_of_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Numeric persisted finding ID this row duplicates, when duplicate analysis marks it non-canonical.",
    ),
  file_path: z
    .string()
    .describe("Repo-relative file path associated with the finding."),
  id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Numeric persisted database finding ID."),
  human_status: z
    .enum(["tp", "fp"])
    .nullable()
    .optional()
    .describe(
      "Independent human TP/FP status; null leaves the AI lifecycle unchanged.",
    ),
  impact: z.string().describe("Concrete security impact."),
  trigger_conditions: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Concrete prerequisites that make an on-chain-confirmed issue exploitable.",
    ),
  triggered_actor: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Actor that can trigger or exploit the issue, such as an external user, administrator, other authorized role, or automated executor.",
    ),
  economic_impact: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Estimated loss, affected value, or valuation method recorded during on-chain confirmation.",
    ),
  confirmation_reason: z
    .string()
    .nullable()
    .optional()
    .describe("Reason supplied when the AI confirmed this candidate finding."),
  note: z
    .string()
    .nullable()
    .optional()
    .describe("Optional human-authored note attached to the finding."),
  rejection_reason: z
    .string()
    .nullable()
    .optional()
    .describe("Reason supplied when the AI rejected this candidate finding."),
  recommendation: z
    .string()
    .nullable()
    .optional()
    .describe("Optional remediation guidance."),
  root_cause: z.string().describe("Root cause summary for the issue."),
  severity: SeveritySchema.describe("Finding severity."),
  session_id: z
    .string()
    .optional()
    .describe("Session ID associated with the persisted finding."),
  source_locations: z
    .array(FindingSourceLocation)
    .optional()
    .describe("Precise source locations for the finding."),
  title: z.string().describe("Short finding title."),
});

export const FindingsResponse = z.object({
  findings: z.array(Finding).describe("Provider-neutral Session findings."),
});

export const HumanConfirmedFindingsMarkdownResponse = z
  .string()
  .describe("UTF-8 Markdown containing explicitly human-confirmed Findings.");

export const AgentMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), content: z.string() }),
  z.object({ type: z.literal("assistant"), content: z.string() }),
  z.object({ type: z.literal("reasoning"), content: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
]);

const UsageMeta = z.record(z.string(), z.unknown()).nullable().optional();

const AcpPromptUsage = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  thoughtTokens: z.number().int().nonnegative().nullable().optional(),
  cachedReadTokens: z.number().int().nonnegative().nullable().optional(),
  cachedWriteTokens: z.number().int().nonnegative().nullable().optional(),
  _meta: UsageMeta,
});

const AcpContextUsage = z.object({
  used: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  cost: z
    .object({
      amount: z.number().nonnegative(),
      currency: z.string(),
      _meta: UsageMeta,
    })
    .nullable()
    .optional(),
  _meta: UsageMeta,
});

const GeminiProviderUsage = z.discriminatedUnion("source", [
  z.object({
    provider: z.literal("gemini"),
    source: z.literal("prompt"),
    usage: AcpPromptUsage,
  }),
  z.object({
    provider: z.literal("gemini"),
    source: z.literal("context"),
    usage: AcpContextUsage,
  }),
]);

export const AgentProviderUsage = z.union([GeminiProviderUsage]);

const SessionLogBase = z.object({
  schemaVersion: z.number().int().positive(),
  sessionId: z.string(),
  time: IsoDateTimeSchema.optional(),
  workflowId: z.string(),
});

export const ProgramLogEntry = SessionLogBase.extend({
  stream: z.literal("program"),
  level: z.number(),
  msg: z.string(),
}).passthrough();

export const AgentLogEntry = z
  .object({
    agent_message: z.unknown().optional(),
    level: z.number().optional(),
    message: AgentMessage.optional(),
    stageIndex: z.number().int().nonnegative().optional(),
    time: z.union([IsoDateTimeSchema, z.number()]).optional(),
    turnIndex: z.number().int().nonnegative().optional(),
    turnStatus: z.enum(["completed", "failed"]).optional(),
  })
  .passthrough();

export const SessionLogEntry = z.union([ProgramLogEntry, AgentLogEntry]);

export const SessionLogsResponse = z.object({
  logOffset: z.number().int().nonnegative(),
  logs: z.array(SessionLogEntry),
  returnedLogCount: z.number().int().nonnegative(),
  totalLogCount: z.number().int().nonnegative(),
});

export const CompatFinding = Finding;

export const CompatFindingsResponse = z.object({
  findings: z
    .array(CompatFinding)
    .describe("Findings returned for the session."),
});

export const CompatLogEntry = z.object({
  function: z.string().describe("Log source or workflow stage label."),
  level: z.string().describe("Normalized log level."),
  line: z.string().describe("Compatibility field; currently empty."),
  message: z.string().describe("Rendered log message."),
  raw: z.string().describe("Original JSON log entry serialized as text."),
  time: IsoDateTimeSchema.describe("Log timestamp."),
});

export const CompatLogsResponse = z.object({
  logOffset: z
    .number()
    .int()
    .nonnegative()
    .describe("Byte offset at the end of the current log file."),
  logs: z.array(CompatLogEntry).describe("Log entries in ascending order."),
  returnedLogCount: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of log entries returned in this response."),
  totalLogCount: z
    .number()
    .int()
    .nonnegative()
    .describe("Total number of log entries in the session log file."),
});

export const CompatProgress = z.object({
  progress: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Progress percentage from 0 to 100."),
  status: PublicProgressStatusSchema.describe("Client-facing session status."),
});

export const CompatProgressResponse = z.object({
  progress: CompatProgress.describe(
    "Nested progress payload for compatibility clients.",
  ),
  running: z.boolean().describe("Whether the audit is currently running."),
  session_id: z.string().describe("Audit session ID."),
  status: PublicProgressStatusSchema.describe("Top-level session status."),
});

export const CompatSessionState = z.object({
  agent_name: z
    .string()
    .optional()
    .describe("Audit agent ID that owns the session."),
  created_at: IsoDateTimeSchema.describe("Session creation timestamp."),
  finished_at: IsoDateTimeSchema.optional().describe(
    "Timestamp when the session entered a terminal status.",
  ),
  finding_count: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of AI-confirmed findings."),
  id: z.string().describe("Audit session ID."),
  pending_finding_count: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of pending findings."),
  project_name: z.string().describe("Display name for the audited project."),
  projectName: z.string().describe("Camel-case alias for project_name."),
  session_id: z.string().describe("Snake-case audit session ID."),
  sessionId: z.string().describe("Camel-case audit session ID."),
  source: z.string().describe("Source/queue label for the session."),
  started_at: IsoDateTimeSchema.optional().describe(
    "Timestamp when the session first started running.",
  ),
  status: CompatAuditStatusSchema.describe(
    "Compatibility audit session lifecycle status.",
  ),
  target_path: z
    .string()
    .describe("Audited target path, relative to the app root when possible."),
});

export const CompatSessionsResponse = z.object({
  page: z.number().int().positive().describe("1-based page number."),
  per_page: z
    .number()
    .int()
    .positive()
    .describe("Number of sessions per page."),
  sessions: z
    .array(CompatSessionState)
    .describe("Audit sessions on the requested page."),
  total: z
    .number()
    .int()
    .nonnegative()
    .describe("Total number of matching sessions."),
});

export const CompatSessionCreateBody = z.object({
  agent_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Snake-case Agent Runtime IDs, one for each Workflow Stage. Invalid IDs fall back to the Workflow defaultModel.",
    ),
  agentIds: z
    .array(z.string())
    .optional()
    .describe(
      "Agent Runtime IDs, one for each Workflow Stage. Invalid IDs fall back to the Workflow defaultModel.",
    ),
  excluded_paths: z
    .array(z.string())
    .optional()
    .describe("Upload-relative paths to exclude before starting the session."),
  excludedPaths: z
    .array(z.string())
    .optional()
    .describe("Camel-case alias for excluded_paths."),
  metadata: JsonObjectSchema.optional().describe(
    "Optional task metadata JSON object.",
  ),
  project_name: z
    .string()
    .optional()
    .describe(
      "Display project name for the session. For upload sessions, defaults to the stored upload project name.",
    ),
  project_source: z
    .enum(["upload", "local"])
    .optional()
    .describe(
      "Project source for the native session API: upload uses upload_id; local uses target_path.",
    ),
  projectName: z
    .string()
    .optional()
    .describe("Camel-case alias for project_name."),
  projectSource: z
    .enum(["upload", "local"])
    .optional()
    .describe("Camel-case alias for project_source."),
  queue_source: z
    .string()
    .optional()
    .describe(
      "Queue/source label alias; sessions with the same source share an execution queue.",
    ),
  queueSource: z
    .string()
    .optional()
    .describe("Camel-case alias for queue_source."),
  source: z
    .string()
    .optional()
    .describe("Queue/source label; defaults to audit-platform when omitted."),
  target_path: z
    .string()
    .optional()
    .describe(
      "Local project path for project_source=local. Defaults to mock when omitted or empty.",
    ),
  targetPath: z
    .string()
    .optional()
    .describe("Camel-case alias for target_path."),
  upload_id: z
    .string()
    .optional()
    .describe("Upload ID returned by upload API."),
  uploadId: z.string().optional().describe("Camel-case alias for upload_id."),
  workflow_id: z.string().optional().describe("Snake-case Workflow ID."),
  workflowId: z.string().describe("Workflow ID."),
});

export const CompatSessionCreateResponse = z.object({
  id: z.string().describe("Audit session ID."),
  project_name: z.string().optional().describe("Display project name."),
  projectName: z
    .string()
    .optional()
    .describe("Camel-case alias for project_name."),
  session_id: z.string().describe("Snake-case audit session ID."),
  sessionId: z.string().describe("Camel-case audit session ID."),
  source: z.string().describe("Source/queue label for the session."),
  status: z.string().describe("Initial session status."),
});

export const DeleteSessionResponse = z.object({
  deleted: z.literal(true).describe("Whether the session was deleted."),
  sessionId: z.string().describe("Deleted audit session ID."),
});

export const SessionRerunBody = z.object({
  agentIds: z
    .array(z.string())
    .describe("Agent Runtime IDs, one for each Workflow Stage."),
  workflowId: z
    .string()
    .optional()
    .describe("Workflow ID to use for the rerun."),
});

export const SessionRerunResponse = z.object({
  agentIds: z
    .array(z.string())
    .describe("Resolved Agent Runtime IDs used for the rerun."),
  workflowId: z.string().describe("Workflow ID used for the rerun."),
  backupDir: z
    .string()
    .optional()
    .describe(
      "Backup directory containing the archived previous session contents.",
    ),
  message: z.string().describe("Human-readable rerun result."),
  redirectTo: z.string().describe("UI path for the rerun session."),
  sessionId: z.string().describe("Rerun audit session ID."),
});

export const SessionDequeueResponse = z.object({
  message: z.string().describe("Human-readable dequeue result."),
  removedQueueItems: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of queued items removed for this session."),
  sessionId: z.string().describe("Dequeued audit session ID."),
  status: z.literal("wait").describe("Current audit session lifecycle status."),
});

export const SessionStopResponse = z.object({
  abortedTurn: z
    .boolean()
    .describe("Whether an in-process Agent turn was aborted."),
  clearedQueueItems: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of persistent queue items cleared for this session."),
  interrupted: z
    .boolean()
    .describe("Whether the session DB status changed to interrupted."),
  message: z.string().describe("Human-readable stop result."),
  sessionId: z.string().describe("Stopped audit session ID."),
  status: AuditStatusSchema.describe("Current audit session lifecycle status."),
});

export const SessionLogsQueryParams = z.object({
  format: z
    .enum(["stream", "text"])
    .optional()
    .describe(
      "Return plain text logs when set to text, Server-Sent Events when set to stream, otherwise JSON logs.",
    ),
  limit: z
    .string()
    .optional()
    .describe(
      "JSON log limit. Defaults to 100; use all to return every log entry.",
    ),
  source: z
    .enum(["agent", "program"])
    .optional()
    .describe("Physical log stream. Defaults to the raw Agent event stream."),
});

export const SessionArtifactTreeEntry = z.object({
  name: z.string().describe("File or directory base name."),
  path: z.string().describe("Session artifact-relative path."),
  size: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("File size in bytes; omitted for directories."),
  type: z.enum(["dir", "file"]).describe("Entry type."),
});

export const SessionArtifactTreeQueryParams = z.object({
  path: z
    .string()
    .optional()
    .describe("Session artifact-relative directory path."),
});

export const SessionArtifactTreeResponse = z.object({
  entries: z.array(SessionArtifactTreeEntry).describe("Directory entries."),
  path: z
    .string()
    .describe("Requested session artifact-relative directory path."),
  session_id: z.string().describe("Snake-case audit session ID."),
  sessionId: z.string().describe("Camel-case audit session ID."),
});

export const SessionArtifactFileQueryParams = z.object({
  path: z.string().describe("Session artifact-relative file path."),
});

export const SessionArtifactFileResponse = z.object({
  content: z.string().describe("UTF-8 file content."),
  encoding: z.literal("utf-8").describe("Content encoding."),
  maxBytes: z
    .number()
    .int()
    .nonnegative()
    .describe("Maximum bytes read before truncation."),
  name: z.string().describe("File base name."),
  path: z.string().describe("Session artifact-relative file path."),
  session_id: z.string().describe("Snake-case audit session ID."),
  sessionId: z.string().describe("Camel-case audit session ID."),
  size: z.number().int().nonnegative().describe("Original file size in bytes."),
  truncated: z.boolean().describe("Whether content was truncated at maxBytes."),
});

export const SessionRepoTreeEntry = SessionArtifactTreeEntry;
export const SessionRepoTreeQueryParams = SessionArtifactTreeQueryParams;
export const SessionRepoTreeResponse = SessionArtifactTreeResponse;
export const SessionRepoFileQueryParams = SessionArtifactFileQueryParams;
export const SessionRepoFileResponse = SessionArtifactFileResponse;

export const FindingReviewFormBody = z.object({
  action: z
    .enum(["confirm", "pass", "reset"])
    .describe(
      "Human review action: confirm the finding as true, pass it as false, or reset the decision.",
    ),
  findingId: z.coerce
    .number()
    .int()
    .positive()
    .describe("Persisted Finding ID to review independently of its AI status."),
});

export const HumanFindingReview = z.object({
  action: z
    .enum(["confirm", "pass"])
    .describe("Current human finding decision."),
  findingKey: z.string().min(1).describe("Stable reviewed finding key."),
  reviewedAt: z.string().describe("ISO timestamp of the latest decision."),
});

export const FindingStateQueryParams = z.object({
  findingId: z.coerce
    .number()
    .int()
    .positive()
    .describe("Persisted numeric finding ID."),
  findingKey: z.string().min(1).describe("Stable finding key to inspect."),
});

export const FindingStateResponse = z.object({
  findingId: z
    .union([z.number(), z.string()])
    .describe("Persisted finding ID."),
  findingKey: z.string().describe("Stable finding key."),
  humanStatus: z
    .enum(["tp", "fp"])
    .nullable()
    .describe("Independent human TP/FP status."),
  note: z.string().nullable().describe("Latest human note, if present."),
  review: HumanFindingReview.nullable().describe(
    "Latest TP/FP decision, if present.",
  ),
  sessionId: z.string().describe("Owning session ID."),
});

export const FindingReviewResponse = z.object({
  action: z
    .enum(["confirm", "pass", "reset"])
    .describe("Applied review action."),
  findingKey: z.string().describe("Stable reviewed finding key."),
  humanStatus: z
    .enum(["tp", "fp"])
    .nullable()
    .describe("Independent human TP/FP status after the update."),
  findingView: z
    .enum([
      "ai-confirmed",
      "human-confirmed",
      "human-rejected",
      "onchain-confirmed",
      "pending",
    ])
    .describe("Target findings view after the update."),
  message: z.string().describe("Human-readable update result."),
  redirectTo: z.string().describe("Target session findings URL."),
  review: HumanFindingReview.nullable().describe(
    "Latest decision, or null after reset.",
  ),
  sessionId: z.string().describe("Updated session ID."),
  source: z.enum(["confirmed", "pending"]).describe("Original finding source."),
});

export const FindingNoteFormBody = z.object({
  findingId: z.coerce
    .number()
    .int()
    .positive()
    .describe("Persisted numeric finding ID."),
  findingView: z
    .enum([
      "ai-confirmed",
      "duplicate-groups",
      "human-confirmed",
      "human-rejected",
      "onchain-confirmed",
      "pending",
    ])
    .optional()
    .describe("Findings view to return to after saving."),
  note: z
    .string()
    .max(findingNoteMaxLength)
    .describe("Human-authored note. An empty value clears the note."),
});

export const FindingNoteResponse = z.object({
  finding: Finding.describe("Finding after the note update."),
  message: z.string().describe("Human-readable update result."),
  redirectTo: z.string().describe("Session findings URL to return to."),
  sessionId: z.string().describe("Updated session ID."),
});

export const AuditAgentDefinition = z.object({
  api: z
    .enum(["glm", "deepseek"])
    .optional()
    .describe("Upstream API profile used by Claude Code agents."),
  available: z
    .boolean()
    .describe("Whether this agent can run in the current environment."),
  displayName: z
    .string()
    .describe(
      "Canonical UI label composed from the Agent provider, model, and reasoning effort.",
    ),
  id: z.string().describe("Stable audit agent ID."),
  model: z.string().describe("Underlying model identifier."),
  modelProvider: z
    .enum(["gpt", "glm", "gemini", "deepseek"])
    .describe("Model provider used for queue concurrency."),
  provider: z
    .enum(["claude", "codex", "gemini"])
    .describe("Agent runtime provider."),
  reasoningEffort: z
    .enum(["no", "low", "medium", "high", "ultra", "xhigh", "max"])
    .optional()
    .describe("Model reasoning effort."),
});

export const AgentsResponse = z.object({
  agents: z.array(AuditAgentDefinition).describe("Registered audit agents."),
});

export const WorkflowTurn = z.object({
  name: z.string().optional(),
  prompt: z.string(),
  goal: z.boolean().optional(),
  skills: z
    .object({
      names: z.array(z.string()).optional(),
      prefixes: z.array(z.string()).optional(),
    })
    .optional(),
  mcp: z.array(z.string()).optional(),
  outputSchema: WorkflowOutputSchemaNameSchema.optional(),
  beforeHooks: z.array(z.string()).optional(),
  afterHooks: z.array(z.string()).optional(),
});

export const WorkflowStage = z.object({
  name: z.string(),
  dependsOn: z.array(z.string()).optional(),
  threadMode: z.enum(["new", "fork", "resume"]).optional(),
  turns: z.array(WorkflowTurn),
});

export const WorkflowDefinition = z.object({
  defaultModel: z
    .string()
    .optional()
    .describe("Default registered Agent ID for this Workflow."),
  name: z.string().optional(),
  stages: z.array(WorkflowStage),
});

export const WorkflowDocumentInput = z.object({
  name: z.string().min(1).max(120).describe("Workflow name."),
  category: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Optional Workflow category."),
  defaultModel: z
    .string()
    .min(1)
    .optional()
    .describe("Default registered Agent ID for this Workflow."),
  description: z
    .string()
    .max(2_000)
    .optional()
    .describe("Optional Workflow description."),
  stages: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        dependsOn: z.array(z.string()),
        threadMode: z.enum(["new", "fork", "resume"]),
        turns: z
          .array(
            WorkflowTurn.extend({
              prompt: z
                .union([z.string().min(1), z.array(z.string()).min(1)])
                .describe("Instruction text or lines sent to the Stage Agent."),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export const WorkflowDefinitionSummary = z.object({
  category: z.string().optional().describe("Optional Workflow category."),
  defaultModel: z
    .string()
    .optional()
    .describe("Default registered Agent ID for this Workflow."),
  description: z.string().optional().describe("Optional Workflow description."),
  id: z.string().describe("Stable Workflow file or built-in ID."),
  label: z.string().describe("Human-readable Workflow name."),
  source: z
    .enum(["code", "file"])
    .describe("Whether the Workflow is built-in or stored as a JSON file."),
  stageCount: z.number().int().positive().describe("Workflow Stage count."),
  stageIds: z
    .array(z.string())
    .describe("Stable derived Workflow Stage IDs in execution order."),
});

export const WorkflowsResponse = z.object({
  defaultWorkflowId: z.string().describe("Default Workflow ID."),
  workflows: z
    .array(WorkflowDefinitionSummary)
    .describe("Built-in and .data/workflow JSON Workflows."),
});

export const WorkflowDocumentResponse = z.object({
  document: WorkflowDocumentInput.describe("Validated Workflow JSON."),
  id: z.string().describe("Stable Workflow file or built-in ID."),
  readOnly: z.boolean().describe("Whether this Workflow is read-only."),
  source: z.enum(["code", "file"]),
});

export const WorkflowDeleteResponse = z.object({
  deleted: z.literal(true),
  workflowId: z.string(),
});

export const SessionWorkflowRefreshResponse = z.object({
  message: z.string().describe("Human-readable refresh result."),
  sessionId: z.string().describe("Audit session ID."),
  workflow: WorkflowDefinition.describe(
    "Latest Workflow definition now stored on the Session.",
  ),
  workflowId: z.string().describe("Workflow ID used to refresh the snapshot."),
});

export const WorkflowTurnState = z.object({
  turnIndex: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
  error: z.string().optional(),
});

export const WorkflowStageState = z.object({
  stageIndex: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  status: z.enum(["pending", "running", "partial", "completed", "failed"]),
  threadId: z.string().optional(),
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
  error: z.string().optional(),
  turns: z.array(WorkflowTurnState),
});

export const WorkflowState = z.object({
  mode: z.enum(["idle", "full", "manual"]),
  status: z.enum(["idle", "running", "partial", "completed", "failed"]),
  stages: z.array(WorkflowStageState),
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
  error: z.string().optional(),
  updatedAt: IsoDateTimeSchema,
});

export const SessionStageRunResponse = z.object({
  attempt: z.number().int().positive().describe("Current Stage attempt."),
  sessionId: z.string().describe("Audit session ID."),
  stageIndex: z.number().int().nonnegative().describe("Executed Stage index."),
  status: AuditStatusSchema.describe(
    "Session lifecycle status after the Stage execution.",
  ),
  workflowState: WorkflowState.describe(
    "Workflow execution state after the Stage execution.",
  ),
});

export const AuditSessionSnapshot = z.object({
  agents: z
    .array(z.string())
    .describe("Resolved Agent Runtime IDs, one for each Workflow Stage."),
  workflowState: WorkflowState.describe(
    "Current Workflow, Stage, and Turn execution state for this Session.",
  ),
  stageAgentAssignments: z
    .record(z.string(), z.string())
    .optional()
    .describe("Resolved Agent IDs keyed by stable Workflow Stage ID."),
  createdAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.optional().describe(
    "Timestamp when the Session entered a terminal status.",
  ),
  findingCount: z.number().int().nonnegative(),
  programLogFile: z.string(),
  agentLogFile: z.string().optional(),
  metadata: JsonObjectSchema.optional(),
  pendingFindingCount: z.number().int().nonnegative(),
  aiConfirmedFindingCount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Number of AI confirmed findings at or above the configured AI Confirm severity threshold, independent of human confirmation or rejection.",
    ),
  projectName: z.string(),
  projectRoot: z.string(),
  sessionDir: z.string(),
  sessionId: z.string(),
  source: z.string().optional(),
  startedAt: IsoDateTimeSchema.optional().describe(
    "Timestamp when the Session first started running.",
  ),
  status: AuditStatusSchema,
  targetPath: z.string(),
  workflow: WorkflowDefinition.describe(
    "Workflow definition snapshot bound to this Session.",
  ),
  workflowId: z.string().describe("Workflow ID."),
  workingDirectory: z.string().optional(),
});

export const SessionsResponse = z.object({
  items: z.array(AuditSessionSnapshot),
  page: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  totalCount: z.number().int().nonnegative(),
});

const SessionCreateBaseBody = z.object({
  agentAssignments: z
    .record(z.string(), z.string())
    .describe(
      "Agent Runtime IDs keyed by stable Workflow Stage ID. Invalid IDs fall back to the Workflow defaultModel.",
    ),
  metadata: JsonObjectSchema.optional(),
  groupName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Optional logical Session Group name. The oldest exact-name Group is reused, or a new Group is created.",
    ),
  projectName: z.string().optional(),
  queueSource: z
    .string()
    .optional()
    .describe("Optional task source label; defaults to audit-platform."),
  run: z
    .boolean()
    .describe(
      "Whether to enqueue the Workflow immediately after creating the Session.",
    ),
  workflowId: z.string().describe("Workflow ID."),
});

export const SessionCreateLocalBody = SessionCreateBaseBody.extend({
  projectSource: z.literal("local"),
  source: z.string().min(1).describe("Local project directory path."),
});

export const SessionCreateUploadBody = SessionCreateBaseBody.extend({
  excludedPaths: z.array(z.string()).optional(),
  projectSource: z.literal("upload"),
  uploadId: z
    .string()
    .min(1)
    .describe("Upload ID returned by POST /api/session/upload."),
});

export const SessionCreateBody = z.discriminatedUnion("projectSource", [
  SessionCreateLocalBody,
  SessionCreateUploadBody,
]);

export const SessionUploadBody = z.object({
  archive: z.string().describe("ZIP archive file.").meta({ format: "binary" }),
  projectName: z.string().optional().describe("Project display name."),
  workflowId: z.string().min(1).describe("Workflow ID."),
});

export const SessionUploadResponse = z.object({
  archiveHash: z.string().describe("SHA-256 hash of the stored archive."),
  projectName: z.string().optional(),
  uploadId: z.string().describe("Upload ID to pass to POST /api/sessions."),
});

export const SessionCreateResponse = z.object({
  agentAssignments: z
    .record(z.string(), z.string())
    .describe("Resolved Agent IDs keyed by frozen Workflow Stage ID."),
  groupId: z
    .string()
    .optional()
    .describe("Reused or created logical Session Group ID."),
  groupName: z.string().optional().describe("Logical Session Group name."),
  projectName: z.string(),
  sessionId: z.string(),
  status: z
    .enum(["wait", "queued"])
    .describe("Initial Session status after applying the run option."),
  workflowId: z.string(),
});

export const SessionGroupMemberCreateBody = z.discriminatedUnion(
  "projectSource",
  [
    z.object({
      projectName: z.string().optional(),
      projectSource: z.literal("local"),
      targetPath: z.string().min(1),
    }),
    z.object({
      excludedPaths: z.array(z.string()).optional(),
      projectName: z.string().optional(),
      projectSource: z.literal("upload"),
      uploadId: z.string().min(1),
    }),
  ],
);

export const SessionGroupCreateBody = z.object({
  agentIds: z
    .array(z.string().trim().min(1))
    .describe("Agent Runtime IDs shared by every Session in the Group."),
  groupName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Logical Session Group name; duplicate names are allowed."),
  metadata: JsonObjectSchema.optional().describe(
    "Optional metadata applied to every created Session.",
  ),
  sessions: z
    .array(SessionGroupMemberCreateBody)
    .min(1)
    .max(500)
    .describe("Project-specific Session inputs, in the requested order."),
  source: z
    .string()
    .optional()
    .describe("Optional source label applied to every created Session."),
  workflowId: z
    .string()
    .trim()
    .min(1)
    .describe("Workflow shared by every Session in the Group."),
});

export const SessionGroupCreatedMember = z.object({
  index: z.number().int().nonnegative().describe("Input Session index."),
  sessionId: z.string().describe("Created audit Session ID."),
  status: z.literal("queued").describe("Initial Session status."),
});

export const SessionGroupFailedMember = z.object({
  error: z.string().describe("Reason this input Session could not be created."),
  index: z.number().int().nonnegative().describe("Input Session index."),
});

export const SessionGroupCreateResponse = z.object({
  created: z
    .array(SessionGroupCreatedMember)
    .describe("Successfully created Sessions, in input order."),
  failed: z
    .array(SessionGroupFailedMember)
    .describe("Sessions that failed to create, in input order."),
  groupId: z.string().describe("Created logical Session Group ID."),
  groupName: z.string().describe("Stored Session Group name."),
});

export const SessionGroupReviewSettingsBody = z.object({
  reviewMinSeverity: SeveritySchema.describe(
    "Minimum Finding severity included in Needs Review for this Group.",
  ),
});

export const SessionGroupReviewSettingsResponse = z.object({
  groupId: z.string().describe("Updated logical Session Group ID."),
  reviewMinSeverity: SeveritySchema.describe(
    "Stored Group-specific Needs Review severity threshold.",
  ),
});

export const SessionGroupDetailsResponse = z.object({
  createdAt: IsoDateTimeSchema.describe(
    "When the logical Session Group was created.",
  ),
  groupId: z.string().describe("Logical Session Group ID."),
  groupName: z.string().describe("Stored Session Group name."),
  reviewMinSeverity: SeveritySchema.describe(
    "Group-specific minimum severity included in Needs Review.",
  ),
  sessions: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .nonnegative()
          .describe("Original input Session index."),
        session: AuditSessionSnapshot.describe(
          "Current associated Session state.",
        ),
      }),
    )
    .describe("Associated Sessions in original input order."),
});

export const DeleteSessionGroupResponse = z.object({
  deleted: z.literal(true).describe("Whether the Session Group was deleted."),
  deletedSessionIds: z
    .array(z.string())
    .describe("IDs of Sessions deleted with the Group."),
  groupId: z.string().describe("Deleted logical Session Group ID."),
});

export const CompatUploadArchiveFormBody = z.object({
  archive: z
    .string()
    .optional()
    .describe("ZIP archive file alias.")
    .meta({ format: "binary" }),
  file: z
    .string()
    .optional()
    .describe("ZIP archive file.")
    .meta({ format: "binary" }),
  metadata: JsonObjectSchema.optional().describe(
    "Optional task metadata JSON object.",
  ),
  project_name: z
    .string()
    .optional()
    .describe(
      "Display project name to store with the upload; defaults to the ZIP file name without its extension.",
    ),
  projectName: z
    .string()
    .optional()
    .describe("Camel-case alias for project_name."),
  queue_source: z
    .string()
    .optional()
    .describe("Queue/source label alias to store with this upload."),
  queueSource: z
    .string()
    .optional()
    .describe("Camel-case alias for queue_source."),
  source: z
    .string()
    .optional()
    .describe(
      "Queue/source label to store with this upload; defaults to audit-platform when omitted.",
    ),
  workflowId: z.string().describe("Workflow ID."),
});

export const UploadArchiveResponse = z.object({
  archive_hash: z.string().describe("SHA-256 hash of the stored archive."),
  archiveHash: z.string().describe("Camel-case alias for archive_hash."),
  metadata: JsonObjectSchema.optional().describe(
    "Normalized metadata saved with the upload.",
  ),
  project_name: z.string().optional().describe("Stored project display name."),
  projectName: z
    .string()
    .optional()
    .describe("Camel-case alias for project_name."),
  source: z.string().describe("Source/queue label stored with this upload."),
  upload_id: z.string().describe("Upload ID to pass to the session start API."),
  uploadId: z.string().describe("Camel-case alias for upload_id."),
});

export const UploadTreeEntry = z.object({
  name: z.string().describe("File or directory base name."),
  path: z.string().describe("Upload-relative path."),
  size: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("File size in bytes; omitted for directories."),
  type: z.enum(["dir", "file"]).describe("Entry type."),
});

export const UploadTreeQueryParams = z.object({
  path: z.string().optional().describe("Upload-relative directory path."),
});

export const UploadTreeResponse = z.object({
  entries: z.array(UploadTreeEntry).describe("Upload directory entries."),
  path: z.string().describe("Requested upload-relative directory path."),
  upload_id: z.string().describe("Snake-case upload ID."),
  uploadId: z.string().describe("Camel-case upload ID."),
});
