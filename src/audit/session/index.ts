import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";

import type { BaseAgent } from "@/audit/agent/base-agent";
import { createAgent } from "@/audit/agent/registry";
import type { WorkflowDefinition } from "@/audit/workflow";
import {
  WorkflowState,
  type WorkflowStateSnapshot,
} from "@/audit/workflow/status";
import {
  appendSessionFindingToDb,
  claimQueuedSessionExecutionInDb,
  claimSessionExecutionInDb,
  confirmSessionFindingInDb,
  listSessionFindingsFromDb,
  markSessionFindingDuplicateInDb,
  onchainConfirmSessionFindingInDb,
  readSessionStateFromDb,
  rejectSessionFindingInDb,
  upsertSessionStateToDb,
  updateSessionWorkflowStateInDb,
  updateSessionStatusInDb,
  updateSessionFindingInDb,
} from "@/server/db/store";
import { SessionFindingStatus } from "@/server/db/schema";
import {
  AuditStatus,
  type Finding,
  type FindingId,
  type FindingSourceLocation,
  type JsonObject,
  type OnchainConfirmation,
  type StoredFinding,
} from "./types";

export {
  DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
  findingReviewSeverityLabel,
  isFindingAtOrAboveReviewSeverity,
} from "./types";
export type { FindingReviewSeverity } from "./types";

const onchainInfoFileName = "onchain_info.json";
const findingsMarkdownFileName = "finding.md";
const onchainInfoMetadataKeys = ["onchain_info", "onchain info"] as const;
const cleanWorkspaceDirName = "repo";
const repoDirName = "repo";

type AgentLogDestination = ReturnType<typeof pino.destination>;

export type SessionFinding = StoredFinding;

export type SessionWorkflowDefinition = WorkflowDefinition & {
  readonly id: string;
};

export type FindingMarkdownInput = Omit<Finding, "duplicate_of_id" | "id"> & {
  duplicate_of_id?: number | string | null;
  id?: number | string;
  status?: string;
};

export type RenderFindingMarkdownOptions = {
  heading?: string;
  status?: string;
};

export type AuditSessionCreateOptions = {
  agents: readonly BaseAgent[];
  stageAgentAssignments?: Record<string, string>;
  createdAt?: string;
  initialStatus?: AuditStatus;
  projectName: string;
  sessionId?: string;
  targetPath: string;
  workflow: SessionWorkflowDefinition;
  source?: string;
  metadata?: JsonObject;
};

export function createAuditSessionId() {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const randomSuffix = randomBytes(6).toString("hex");

  return `${timestamp}-${randomSuffix}`;
}

export class AuditSession {
  readonly sessionId: string;

  readonly projectName: string;
  readonly targetPath: string;
  readonly source?: string;
  readonly metadata?: JsonObject;
  readonly workflow: WorkflowDefinition;
  readonly workflowId: string;
  readonly stageAgentAssignments: Readonly<Record<string, string>>;
  readonly agents: readonly BaseAgent[];

  readonly workflowState: WorkflowState;
  readonly agentLogger: pino.Logger;
  private readonly createdAt: string;
  private readonly agentLogDestination: AgentLogDestination;
  private agentLogDestinationError: Error | undefined;
  private agentLoggerClosePromise: Promise<void> | undefined;
  private status: AuditStatus;
  sessionDirectoryPath: string;
  repoDirectoryPath: string;

  private constructor(
    {
      agents,
      projectName,
      targetPath,
      workflow,
      stageAgentAssignments,
      source,
      metadata,
    }: AuditSessionCreateOptions,
    sessionId: string,
    status: AuditStatus = AuditStatus.QUEUED,
    createdAt = new Date().toISOString(),
    workflowState?: WorkflowStateSnapshot,
  ) {
    assertSharedThreadAgentAssignments(workflow, agents);
    this.sessionId = sessionId;
    this.sessionDirectoryPath = path.join(
      /* turbopackIgnore: true */ process.cwd(),
      ".data",
      "session",
      this.sessionId,
    );

    this.agentLogDestination = pino.destination({
      dest: path.join(this.sessionDirectoryPath, "agent.log"),
      mkdir: true,
      sync: false,
    });
    this.agentLogDestination.on("error", (error) => {
      this.agentLogDestinationError ??= error;
    });
    this.agentLogger = pino({ base: null }, this.agentLogDestination);
    this.createdAt = createdAt;
    this.projectName = projectName;
    this.status = status;
    this.targetPath = targetPath;
    this.workflow = workflow;
    this.workflowId = workflow.id;
    this.workflowState = new WorkflowState(
      workflow,
      (state) =>
        updateSessionWorkflowStateInDb({
          sessionId: this.sessionId,
          workflowState: state,
        }),
      workflowState,
    );
    this.stageAgentAssignments = { ...(stageAgentAssignments ?? {}) };
    this.source = source;
    this.metadata = metadata;
    this.agents = [...agents];
    this.repoDirectoryPath = path.join(this.sessionDirectoryPath, repoDirName);
  }

  close() {
    this.agentLoggerClosePromise ??= this.closeAgentLogDestination();
    return this.agentLoggerClosePromise;
  }

  private async closeAgentLogDestination() {
    if (this.agentLogDestinationError) {
      throw this.agentLogDestinationError;
    }

    await new Promise<void>((resolve, reject) => {
      this.agentLogDestination.flush((error) =>
        error ? reject(error) : resolve(),
      );
    });

    const closed = once(this.agentLogDestination, "close");
    this.agentLogDestination.end();
    await closed;

    if (this.agentLogDestinationError) {
      throw this.agentLogDestinationError;
    }
  }

  static async createAuditSession(options: AuditSessionCreateOptions) {
    const sessionId = options.sessionId ?? createAuditSessionId();
    const session = new AuditSession(
      options,
      sessionId,
      options.initialStatus,
      options.createdAt,
    );
    await mkdir(session.sessionDirectoryPath, { recursive: true });
    await upsertSessionStateToDb({
      agents: session.agents.map((agent) => agent.id),
      agentLogFile: path.join(session.sessionDirectoryPath, "agent.log"),
      createdAt: session.createdAt,
      workflowState: session.workflowState.toJSON(),
      finishedAt: undefined,
      findingCount: 0,
      metadata: session.metadata,
      pendingFindingCount: 0,
      aiConfirmedFindingCount: 0,
      programLogFile: path.join(session.sessionDirectoryPath, "program.log"),
      projectName: session.projectName,
      projectRoot: process.cwd(),
      sessionDir: session.sessionDirectoryPath,
      sessionId: session.sessionId,
      source: session.source,
      startedAt: undefined,
      status: session.status,
      targetPath: session.targetPath,
      workflow: session.workflow,
      workflowId: session.workflowId,
      stageAgentAssignments: session.stageAgentAssignments,
      workingDirectory: path.join(
        session.sessionDirectoryPath,
        cleanWorkspaceDirName,
      ),
    });
    return session;
  }

  static async restore(sessionId: string) {
    const state = await readSessionStateFromDb(sessionId);
    if (!state) {
      throw new Error(`AuditSession not found: ${sessionId}`);
    }
    if (state.agents.length === 0) {
      throw new Error(`AuditSession ${sessionId} has no Agents.`);
    }

    const session = new AuditSession(
      {
        agents: state.agents.map(createAgent),
        metadata: state.metadata as JsonObject | undefined,
        projectName: state.projectName,
        source: state.source,
        targetPath: state.targetPath,
        workflow: Object.assign(state.workflow, { id: state.workflowId }),
        stageAgentAssignments: state.stageAgentAssignments,
      },
      state.sessionId,
      state.status,
      state.createdAt,
      state.workflowState,
    );

    return session;
  }

  async setStatus(status: AuditStatus) {
    const changed = await updateSessionStatusInDb({
      sessionId: this.sessionId,
      status,
    });
    if (!changed) {
      return false;
    }

    this.status = status;
    return true;
  }

  async claimExecution() {
    const claimed = await claimSessionExecutionInDb(this.sessionId);
    if (claimed) {
      this.status = AuditStatus.RUNNING;
    }
    return claimed;
  }

  async claimQueuedExecution() {
    const claimed = await claimQueuedSessionExecutionInDb(this.sessionId);
    if (claimed) {
      this.status = AuditStatus.RUNNING;
    }
    return claimed;
  }

  async addFinding(finding: Finding): Promise<Finding> {
    try {
      return (
        await appendSessionFindingToDb({
          finding,
          status: SessionFindingStatus.PENDING,
          sessionId: this.sessionId,
        })
      ).finding;
    } catch {
      return finding;
    }
  }

  async addConfirmedFinding(finding: Finding): Promise<Finding> {
    return (
      await appendSessionFindingToDb({
        finding,
        status: SessionFindingStatus.CONFIRMED,
        sessionId: this.sessionId,
      })
    ).finding;
  }

  async markDuplicateFinding(
    findingId: FindingId | string,
    duplicateOfId: FindingId | string,
  ): Promise<Finding> {
    let finding: Finding | null;

    try {
      finding = await markSessionFindingDuplicateInDb({
        duplicateOfId,
        findingId,
        sessionId: this.sessionId,
      });
    } catch {
      finding = null;
    }

    if (!finding) {
      throw new Error(`Finding not found: ${findingId}`);
    }

    return finding;
  }

  async confirmFinding(
    findingId: FindingId | string,
    reason: string,
  ): Promise<Finding> {
    let finding: Finding | null;

    try {
      finding = await confirmSessionFindingInDb({
        findingId,
        reason,
        sessionId: this.sessionId,
      });
    } catch {
      finding = null;
    }

    if (!finding) {
      throw new Error(`Finding not found: ${findingId}`);
    }

    return finding;
  }

  async rejectFinding(
    findingId: FindingId | string,
    reason: string,
  ): Promise<Finding> {
    const finding = await rejectSessionFindingInDb({
      findingId,
      reason,
      sessionId: this.sessionId,
    });

    if (!finding) {
      throw new Error(`Pending candidate finding not found: ${findingId}`);
    }

    return finding;
  }

  async onchainConfirmFinding(
    findingId: FindingId | string,
    confirmation: OnchainConfirmation,
  ): Promise<Finding> {
    const finding = await onchainConfirmSessionFindingInDb({
      economicImpact: confirmation.economic_impact,
      findingId,
      sessionId: this.sessionId,
      triggeredActor: confirmation.triggered_actor,
      triggerConditions: confirmation.trigger_conditions,
    });

    if (!finding) {
      throw new Error(`Pending candidate finding not found: ${findingId}`);
    }

    return finding;
  }

  async updateFinding(finding: Finding): Promise<Finding> {
    let updatedFinding: Finding | null;

    try {
      updatedFinding = await updateSessionFindingInDb({
        finding,
        sessionId: this.sessionId,
      });
    } catch {
      updatedFinding = null;
    }

    if (!updatedFinding) {
      throw new Error(`Pending finding not found: ${String(finding.id)}`);
    }

    return updatedFinding;
  }

  async readAllFindings(): Promise<SessionFinding[]> {
    try {
      return await listSessionFindingsFromDb({
        sessionId: this.sessionId,
      });
    } catch {
      return [];
    }
  }

  async readPendingFindings(): Promise<SessionFinding[]> {
    return (await this.readAllFindings()).filter(
      (finding) => finding.status === SessionFindingStatus.PENDING,
    );
  }

  static renderFindingMarkdown(
    finding: FindingMarkdownInput,
    options: RenderFindingMarkdownOptions = {},
  ) {
    const lines: Array<string | undefined> = [
      `# ${options.heading ?? "Finding"}`,
      "",
      `- Database Finding ID: ${inlineCode(finding.id ?? "missing")}`,
      options.status || finding.status
        ? `- Status: ${inlineCode(options.status ?? finding.status ?? "")}`
        : undefined,
      finding.session_id
        ? `- Session ID: ${inlineCode(finding.session_id)}`
        : undefined,
      finding.duplicate_of_id
        ? `- Duplicate Of Finding ID: ${inlineCode(finding.duplicate_of_id)}`
        : undefined,
      `- Title: ${textOrFallback(finding.title)}`,
      `- Severity: ${inlineCode(finding.severity)}`,
      `- File: ${inlineCode(finding.file_path)}`,
      "",
      "## Root Cause",
      "",
      textOrFallback(finding.root_cause),
      "",
      "## Impact",
      "",
      textOrFallback(finding.impact),
      "",
      ...(finding.trigger_conditions
        ? [
            "## Trigger Conditions",
            "",
            textOrFallback(finding.trigger_conditions),
            "",
          ]
        : []),
      ...(finding.triggered_actor
        ? [
            "## Triggered Actor",
            "",
            textOrFallback(finding.triggered_actor),
            "",
          ]
        : []),
      ...(finding.economic_impact
        ? [
            "## Economic Impact",
            "",
            textOrFallback(finding.economic_impact),
            "",
          ]
        : []),
      ...(finding.rejection_reason
        ? [
            "## Rejection Reason",
            "",
            textOrFallback(finding.rejection_reason),
            "",
          ]
        : []),
      ...(finding.confirmation_reason
        ? [
            "## Confirmation Reason",
            "",
            textOrFallback(finding.confirmation_reason),
            "",
          ]
        : []),
      "## Description",
      "",
      textOrFallback(finding.description),
      "",
      ...(finding.recommendation
        ? ["## Recommendation", "", textOrFallback(finding.recommendation), ""]
        : []),
      ...(finding.note
        ? ["## Review Note", "", textOrFallback(finding.note), ""]
        : []),
      ...renderSourceLocations(finding.source_locations),
    ];

    return lines.filter((line) => line !== undefined).join("\n");
  }

  static renderFindingsMarkdown(findings: readonly FindingMarkdownInput[]) {
    if (findings.length === 0) {
      return ["# Findings", "", "No findings have been submitted yet."].join(
        "\n",
      );
    }

    return [
      "# Findings",
      "",
      ...findings.flatMap((finding) =>
        nestFindingMarkdownHeadings(
          AuditSession.renderFindingMarkdown(finding, {
            heading: `${finding.id ?? "missing"}. ${finding.title}`,
          }),
        ),
      ),
    ].join("\n");
  }

  async renderFindingsMarkdownArtifact() {
    const filePath = path.join(
      this.sessionDirectoryPath,
      findingsMarkdownFileName,
    );
    const markdown = AuditSession.renderFindingsMarkdown(
      await this.readAllFindings(),
    );
    await writeFile(filePath, `${markdown}\n`, "utf8");
    return filePath;
  }

  async copySourceToWorkingDirectory(): Promise<void> {
    const sourcePath = path.resolve(this.targetPath);
    const destinationPath = path.resolve(
      path.join(this.sessionDirectoryPath, cleanWorkspaceDirName),
    );

    const sourceStat = await lstat(sourcePath).catch(() => undefined);
    if (!sourceStat) {
      throw new Error(`Target path does not exist: ${sourcePath}`);
    }

    if (sourceStat.isDirectory()) {
      await rm(destinationPath, { force: true, recursive: true });
      await cp(sourcePath, destinationPath, { recursive: true });
    } else if (sourceStat.isFile()) {
      await rm(destinationPath, { force: true, recursive: true });
      await mkdir(destinationPath, { recursive: true });
      await cp(
        sourcePath,
        path.join(destinationPath, path.basename(sourcePath)),
      );
    }
  }

  async writeOnchainInfoToSessionDirectory() {
    const onchainInfo = (() => {
      if (!this.metadata) {
        return undefined;
      }

      for (const key of onchainInfoMetadataKeys) {
        if (Object.hasOwn(this.metadata, key)) {
          return this.metadata[key];
        }
      }
    })();

    if (onchainInfo === undefined) {
      return;
    }

    const filePath = path.join(this.sessionDirectoryPath, onchainInfoFileName);
    await writeFile(
      filePath,
      `${JSON.stringify(onchainInfo, null, 2)}\n`,
      "utf8",
    );
    return filePath;
  }
}

function assertSharedThreadAgentAssignments(
  workflow: WorkflowDefinition,
  agents: readonly BaseAgent[],
) {
  const stageIndexByName = new Map(
    workflow.stages.map((stage, stageIndex) => [stage.name, stageIndex]),
  );
  for (const [stageIndex, stage] of workflow.stages.entries()) {
    if (stage.threadMode !== "fork" && stage.threadMode !== "resume") continue;
    const dependency = stage.dependsOn?.[0];
    const parentIndex =
      dependency === undefined ? undefined : stageIndexByName.get(dependency);
    const agent = agents[stageIndex];
    const parentAgent =
      parentIndex === undefined ? undefined : agents[parentIndex];
    if (agent && parentAgent && agent.id !== parentAgent.id) {
      const mode = stage.threadMode === "fork" ? "Fork" : "Resume";
      throw new Error(
        `${mode} Workflow Stage ${stage.name} must use the same Agent as ${dependency}.`,
      );
    }
  }
}

function nestFindingMarkdownHeadings(markdown: string) {
  return markdown.split("\n").map((line) => {
    if (line.startsWith("## ")) {
      return `### ${line.slice(3)}`;
    }

    if (line.startsWith("# ")) {
      return `## ${line.slice(2)}`;
    }

    return line;
  });
}

function renderSourceLocations(locations?: FindingSourceLocation[]) {
  if (!locations || locations.length === 0) {
    return [];
  }

  return [
    "## Source Locations",
    "",
    ...locations.flatMap((location, index) => {
      const lineRange = location.end_line
        ? `${location.start_line}-${location.end_line}`
        : String(location.start_line);
      return [
        `### ${index + 1}. ${inlineCode(`${location.file}:${lineRange}`)}`,
        "",
        location.snippet ? codeBlock(location.snippet) : undefined,
        "",
      ];
    }),
  ].filter((line) => line !== undefined);
}

function textOrFallback(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : "N/A";
}

function inlineCode(value: number | string) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function codeBlock(value: string) {
  const fence = codeFenceFor(value);
  return `${fence}\n${value.trim()}\n${fence}`;
}

function codeFenceFor(value: string) {
  const longestBacktickRun = Math.max(
    2,
    ...[...value.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return "`".repeat(longestBacktickRun + 1);
}
