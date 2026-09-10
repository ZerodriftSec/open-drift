import { workflowProgress } from "@/audit/workflow/status";
import {
  getSessionDetails,
  listSessionPage,
  type Finding,
  type SessionDetailsOptions,
  type SessionDetails,
  type AuditSessionSnapshot,
} from ".";

export type CompatSessionCreateResponse = {
  id: string;
  projectName?: string;
  project_name?: string;
  sessionId: string;
  session_id: string;
  source?: string;
  status: string;
};

export async function listCompatSessions({
  page,
  perPage,
}: {
  page?: number;
  perPage?: number;
} = {}) {
  const sessionPage = await listSessionPage({
    page,
    pageSize: perPage,
  });

  return {
    page: sessionPage.page,
    per_page: sessionPage.pageSize,
    sessions: sessionPage.items.map(toCompatSessionState),
    total: sessionPage.totalCount,
  };
}

export async function getRequiredSessionDetails(
  sessionId: string,
  projectRoot = process.cwd(),
  options: SessionDetailsOptions = {},
) {
  const details = await getSessionDetails(sessionId, projectRoot, options);
  if (!details) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return details;
}

export function toCompatSessionCreateResponse(
  sessionId: string,
  status = "running",
  projectName?: string,
  source?: string,
): CompatSessionCreateResponse {
  return {
    id: sessionId,
    ...(projectName ? { projectName, project_name: projectName } : {}),
    sessionId,
    session_id: sessionId,
    ...(source ? { source } : {}),
    status,
  };
}

export function toCompatSessionState(state: AuditSessionSnapshot) {
  return {
    created_at: state.createdAt,
    finished_at: state.finishedAt,
    finding_count: state.findingCount,
    id: state.sessionId,
    pending_finding_count: state.pendingFindingCount,
    projectName: state.projectName,
    project_name: state.projectName,
    sessionId: state.sessionId,
    session_id: state.sessionId,
    source: state.source,
    started_at: state.startedAt,
    status: state.status === "failed" ? "failure" : state.status,
    target_path: state.targetPath,
    workflow_id: state.workflowId,
  };
}

export async function toCompatProgress(details: SessionDetails) {
  const { state } = details;
  const running = state.status === "running";
  const status = toCompatProgressStatus(state.status);
  const progress = workflowProgress(state.workflowState).percentage;

  return {
    progress: {
      progress,
      status,
    },
    running,
    session_id: state.sessionId,
    status,
  };
}

export function toCompatFindings(details: SessionDetails) {
  return {
    findings: details.findings.map(toCompatFinding),
  };
}

function toCompatProgressStatus(status: AuditSessionSnapshot["status"]) {
  if (status === "queued") {
    return "queued";
  }

  if (status === "failed") {
    return "failed";
  }

  if (status === "interrupted") {
    return "stopped";
  }

  return status;
}

function toCompatFinding(finding: Finding) {
  const compatFinding: Finding = {
    description: finding.description,
    file_path: finding.file_path,
    impact: finding.impact,
    root_cause: finding.root_cause,
    severity: finding.severity,
    title: finding.title,
    id: finding.id,
    session_id: finding.session_id,
  };

  if (finding.recommendation) {
    compatFinding.recommendation = finding.recommendation;
  }

  if (finding.trigger_conditions) {
    compatFinding.trigger_conditions = finding.trigger_conditions;
  }

  if (finding.triggered_actor) {
    compatFinding.triggered_actor = finding.triggered_actor;
  }

  if (finding.economic_impact) {
    compatFinding.economic_impact = finding.economic_impact;
  }

  if (finding.note) {
    compatFinding.note = finding.note;
  }

  if (finding.human_status) {
    compatFinding.human_status = finding.human_status;
  }

  if (finding.duplicate_of_id) {
    compatFinding.duplicate_of_id = finding.duplicate_of_id;
  }

  if (finding.source_locations) {
    compatFinding.source_locations = finding.source_locations;
  }

  return compatFinding;
}
