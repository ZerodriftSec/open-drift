import type { WorkflowDefinitionSummary } from "@/server/workflows";
import { listWorkflowDefinitions } from "@/server/workflows";
import {
  listAgentDefinitions,
  type AuditAgentDefinition,
} from "@/audit/agent/registry";
import { AppShell } from "@/app/components/layout/app-shell";
import { FindingInteractions } from "@/app/components/dashboard/finding-interactions";
import { MetadataSummaryLine } from "@/app/components/dashboard/metadata-summary-line";
import {
  SessionDeleteButton,
  SessionDequeueButton,
  SessionRerunButton,
  SessionStopButton,
} from "@/app/components/sessions/session-action-buttons";
import { SessionAutoRefresh } from "@/app/components/sessions/session-auto-refresh";
import { SessionCreatedRefresh } from "@/app/components/sessions/session-created-refresh";
import { HumanConfirmedFindingsExportButton } from "@/app/components/sessions/human-confirmed-findings-export-button";
import { SessionGroupDeleteButton } from "@/app/components/sessions/session-group-delete-button";
import { SessionGroupReviewSeverityButton } from "@/app/components/sessions/session-group-review-severity-button";
import { SessionArtifactsBrowser } from "@/app/components/sessions/session-artifacts-browser";
import { SessionLogViewer } from "@/app/components/sessions/session-log-viewer";
import { SessionWorkflowViewer } from "@/app/components/sessions/session-workflow-viewer";
import { Badge, findingSeverityTone } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardBody, CardHeader } from "@/app/components/ui/card";
import { cn } from "@/app/components/ui/cn";
import { LocalDateTime } from "@/app/components/ui/local-date-time";
import { Markdown } from "@/app/components/ui/markdown";
import { ProgressBar } from "@/app/components/ui/progress-bar";
import { SegmentedControl } from "@/app/components/ui/segmented-control";
import { Tabs } from "@/app/components/ui/tabs";
import { CreateSessionButton } from "@/app/components/uploads/upload-dialog";
import { workflowProgress } from "@/audit/workflow/status";
import {
  formatCost,
  formatDuration,
  formatTokens,
  totalTokens,
} from "@/lib/format";
import {
  appendQueryString,
  sessionPagePath,
  sessionsPagePath,
} from "@/lib/page-routes";
import { parseFindingView, type FindingView } from "@/lib/dashboard-params";
import { ensureAppRuntimeCleanup } from "@/server/runtime/cleanup";
import {
  AuditStatus,
  findingKeyFor,
  getSessionDetails,
  type Finding,
  type FindingSource,
  type HumanFindingStatus,
  type RunSummary,
  type SessionDuplicateFindingGroup,
  type AuditSessionSnapshot,
} from "@/server/sessions";
import {
  DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
  findingReviewSeverityLabel,
  isFindingAtOrAboveReviewSeverity,
  type FindingReviewSeverity,
} from "@/audit/session";
import {
  getSessionReviewMinSeverity,
  listSessionGroupMemberPage,
  listSessionGroupHierarchyPage,
  type SessionFindingSeverityCounts,
  type SessionGroupHierarchyItem,
  type SessionGroupHierarchySession,
  type SessionGroupHierarchyView,
  type SessionGroupMemberPage,
  type SessionGroupMemberView,
} from "@/server/session-groups";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  FileWarning,
  FolderOpen,
  ScrollText,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

type MainView = "artifacts" | "findings" | "logs" | "workflow";
type FindingItemView = Exclude<
  FindingView,
  "all-findings" | "duplicate" | "duplicate-groups" | "needs-review"
>;
type LogView = "logs" | "raw-logs";
type FindingItem = {
  finding: Finding;
  findingKey: string;
  humanStatus?: HumanFindingStatus | null;
  index: number;
  source: FindingSource | "duplicate";
  view: FindingItemView;
};
export type DashboardPageSearchParams = {
  expandedGroup?: string;
  findingReviewError?: string;
  findingView?: string;
  groupPage?: string;
  groupView?: string;
  logView?: string;
  createdSessionId?: string;
  sessionActionError?: string;
  sessionListView?: string;
  sessionPage?: string;
  uploadError?: string;
  view?: string;
};

export type DashboardResource = { id: string; type: "session" };

type SessionDetailPageProps = {
  resource: DashboardResource;
  searchParams?: Promise<DashboardPageSearchParams>;
};

type SessionsListPageProps = {
  searchParams?: Promise<DashboardPageSearchParams>;
};

const SESSION_PAGE_SIZE = 20;
const GROUP_SESSION_PAGE_SIZE = 100;
const INITIAL_SESSION_LOG_COUNT = 100;

export async function SessionsListPage({
  searchParams,
}: SessionsListPageProps) {
  await ensureAppRuntimeCleanup(process.cwd());

  const params = await searchParams;
  const requestedSessionPage = parsePageNumber(params?.sessionPage);
  const sessionListView = parseSessionListView(params?.sessionListView);
  const requestedGroupPage = parsePageNumber(params?.groupPage);
  const groupView = parseSessionGroupMemberView(params?.groupView);
  const expandedGroupId =
    sessionListView === "groups"
      ? normalizedOptionalString(params?.expandedGroup)
      : undefined;
  const reviewMinSeverity = DEFAULT_FINDING_REVIEW_MIN_SEVERITY;
  const agentDisplayNamesById = new Map(
    listAgentDefinitions().map((agent) => [agent.id, agent.displayName]),
  );
  const sessionPage = await listSessionGroupHierarchyPage({
    page: requestedSessionPage,
    pageSize: SESSION_PAGE_SIZE,
    view: sessionListView,
  });

  if (sessionPage.page !== requestedSessionPage) {
    redirect(sessionListHref(sessionPage.page, sessionListView));
  }

  const expandedItem = expandedGroupId
    ? sessionPage.items.find(
        (item) => item.kind === "group" && item.groupId === expandedGroupId,
      )
    : undefined;
  const expandedGroup =
    expandedItem?.kind === "group" ? expandedItem : undefined;
  if (
    (sessionListView !== "groups" && hasGroupListParams(params)) ||
    (!expandedGroupId && (params?.groupPage || params?.groupView)) ||
    (expandedGroupId && !expandedGroup)
  ) {
    redirect(sessionListHref(sessionPage.page, sessionListView));
  }

  const groupMemberPage = expandedGroup
    ? await listSessionGroupMemberPage({
        groupId: expandedGroup.groupId,
        page: requestedGroupPage,
        pageSize: GROUP_SESSION_PAGE_SIZE,
        view: groupView,
      })
    : null;
  if (
    expandedGroup &&
    groupMemberPage &&
    (groupMemberPage.page !== requestedGroupPage ||
      params?.expandedGroup !== expandedGroup.groupId ||
      params?.groupPage !== canonicalPageParam(groupMemberPage.page) ||
      params?.groupView !== canonicalGroupViewParam(groupView))
  ) {
    redirect(
      sessionListHref(sessionPage.page, "groups", {
        expandedGroup: expandedGroup.groupId,
        groupPage: groupMemberPage.page,
        groupView,
      }),
    );
  }

  const hasActiveSessions = sessionPage.items.some((item) =>
    item.kind === "session"
      ? isActiveSessionListItem(item.session)
      : item.activeSessionCount > 0,
  );

  return (
    <AppShell activeNav="sessions" title="Sessions">
      <SessionAutoRefresh enabled={hasActiveSessions} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable] md:p-5">
        <div className="mx-auto grid w-full max-w-6xl gap-3">
          <Tabs
            value={sessionListView}
            items={[
              {
                count: sessionPage.ungroupedSessionCount,
                href: sessionListHref(1, "sessions"),
                label: "Session",
                value: "sessions",
              },
              {
                count: sessionPage.groupCount,
                href: sessionListHref(1, "groups"),
                label: "Group",
                value: "groups",
              },
            ]}
          />
          {sessionPage.items.length > 0 ? (
            <section className="overflow-hidden rounded-app-lg border border-app-border bg-app-surface">
              <div className="hidden grid-cols-[minmax(220px,300px)_120px_160px_130px_140px_150px_92px] gap-4 border-b border-app-border bg-app-surface-muted px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted sm:grid">
                <span>Name</span>
                <span>
                  {sessionListView === "groups" ? "Sessions" : "Status"}
                </span>
                <span
                  className={
                    sessionListView === "groups" ? "text-center" : undefined
                  }
                >
                  {sessionListView === "groups" ? "Completion" : "Findings"}
                </span>
                <span className="text-center">
                  {sessionListView === "groups"
                    ? "Needs Review"
                    : `Needs Review ≥ ${findingReviewSeverityLabel(reviewMinSeverity)}`}
                </span>
                <span className="text-center">Human Confirmed</span>
                <span>Created</span>
                <span aria-hidden="true" />
              </div>
              <div className="divide-y divide-app-border-faint">
                {sessionPage.items.map((item) => (
                  <SessionListItem
                    agentDisplayNamesById={agentDisplayNamesById}
                    item={item}
                    key={
                      item.kind === "group"
                        ? item.groupId
                        : item.session.sessionId
                    }
                    expanded={
                      item.kind === "group" &&
                      item.groupId === expandedGroup?.groupId
                    }
                    groupMemberPage={
                      item.kind === "group" &&
                      item.groupId === expandedGroup?.groupId
                        ? groupMemberPage
                        : null
                    }
                    groupView={groupView}
                    returnPage={sessionPage.page}
                    sessionListView={sessionListView}
                  />
                ))}
              </div>
            </section>
          ) : (
            <div className="grid min-h-72 place-items-center rounded-app-lg border border-dashed border-app-border bg-app-surface px-6 py-10 text-center">
              <div className="grid justify-items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-app-surface-muted text-app-text-faint">
                  <FolderOpen className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="grid gap-0.5">
                  <h2 className="m-0 text-[14px] font-semibold text-app-text">
                    {sessionListView === "groups"
                      ? "No Session Groups yet"
                      : "No Sessions yet"}
                  </h2>
                  <p className="m-0 text-[12px] text-app-text-muted">
                    {sessionListView === "groups"
                      ? "Created Groups will appear here."
                      : "Sessions that do not belong to a Group will appear here."}
                  </p>
                </div>
                {sessionListView === "sessions" ? (
                  <CreateSessionButton />
                ) : null}
              </div>
            </div>
          )}

          <SessionListPagination
            page={sessionPage.page}
            sessionListView={sessionListView}
            totalCount={sessionPage.totalCount}
            totalPages={sessionPage.totalPages}
          />
        </div>
      </div>
    </AppShell>
  );
}

export default async function SessionDetailPage({
  resource,
  searchParams,
}: SessionDetailPageProps) {
  await ensureAppRuntimeCleanup(process.cwd());

  const params = await searchParams;
  const requestedSessionPage = parsePageNumber(params?.sessionPage);
  const sessionListView = parseSessionListView(params?.sessionListView);
  const sidebarPageParams: SidebarPageParams = {
    expandedGroup:
      sessionListView === "groups"
        ? normalizedOptionalString(params?.expandedGroup)
        : undefined,
    groupPage: parsePageNumber(params?.groupPage),
    groupView: parseSessionGroupMemberView(params?.groupView),
    sessionListView,
    sessionPage: requestedSessionPage,
  };
  const selectedSessionId = resource.id;
  const view: MainView = parseMainView(params?.view);
  const findingView = parseFindingView(params?.findingView);
  const logView = parseLogView(params?.logView);

  if (
    shouldRedirectToCanonicalDashboardHref({
      findingView,
      logView,
      params,
      requestedSidebarPageParams: sidebarPageParams,
      resource,
      view,
    })
  ) {
    redirect(
      canonicalDashboardHref({
        findingView,
        logView,
        params,
        requestedSidebarPageParams: sidebarPageParams,
        resource,
        view,
      }),
    );
  }

  const agentOptions = listAgentDefinitions();
  const [workflowOptions, selectedSession, reviewMinSeverity] =
    await Promise.all([
      listWorkflowDefinitions(),
      getSessionDetails(selectedSessionId, process.cwd(), {
        logLimit: INITIAL_SESSION_LOG_COUNT,
        logStream: "agent",
      }),
      getSessionReviewMinSeverity(selectedSessionId),
    ]);
  const selectedSessionProgressPercentage = selectedSession
    ? workflowProgress(selectedSession.state.workflowState).percentage
    : 0;

  return (
    <AppShell
      activeNav="sessions"
      breadcrumbs={[
        {
          href: sessionListHref(
            requestedSessionPage,
            sessionListView,
            sidebarPageParams,
          ),
          label: "Sessions",
        },
        {
          label: selectedSession
            ? sessionProjectName(selectedSession.state)
            : "Session",
        },
      ]}
      title={
        selectedSession ? sessionProjectName(selectedSession.state) : "Session"
      }
    >
      <SessionCreatedRefresh createdSessionId={params?.createdSessionId} />
      <SessionAutoRefresh
        enabled={
          view !== "workflow" &&
          (selectedSession?.state.status === "queued" ||
            selectedSession?.state.status === "running")
        }
        initialLogOffset={selectedSession?.logOffset}
        sessionId={selectedSession?.state.sessionId}
      />
      {selectedSession ? (
        <SessionView
          agentOptions={agentOptions}
          workflowOptions={workflowOptions}
          key={`session-${selectedSession.state.sessionId}`}
          details={selectedSession}
          findingView={findingView}
          progressPercentage={selectedSessionProgressPercentage}
          reviewMinSeverity={reviewMinSeverity}
          reviewError={params?.findingReviewError}
          sessionActionError={params?.sessionActionError}
          logView={logView}
          sidebarPageParams={sidebarPageParams}
          view={view}
        />
      ) : (
        <SessionPlaceholder />
      )}
    </AppShell>
  );
}

function SessionListPagination({
  page,
  sessionListView,
  totalCount,
  totalPages,
}: {
  page: number;
  sessionListView: SessionGroupHierarchyView;
  totalCount: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  return (
    <nav
      aria-label="Session List pagination"
      className="flex items-center justify-between gap-3 text-[11px] text-app-text-muted"
    >
      <span className="font-mono">
        Page {page} of {totalPages} · {totalCount} items
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          disabled={page <= 1}
          href={
            page > 1 ? sessionListHref(page - 1, sessionListView) : undefined
          }
          size="sm"
          variant="outline"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Previous
        </Button>
        <Button
          disabled={page >= totalPages}
          href={
            page < totalPages
              ? sessionListHref(page + 1, sessionListView)
              : undefined
          }
          size="sm"
          variant="outline"
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

function SessionListItem({
  agentDisplayNamesById,
  expanded,
  groupMemberPage,
  groupView,
  item,
  returnPage,
  sessionListView,
}: {
  agentDisplayNamesById: ReadonlyMap<string, string>;
  expanded: boolean;
  groupMemberPage: SessionGroupMemberPage | null;
  groupView: SessionGroupMemberView;
  item: SessionGroupHierarchyItem;
  returnPage: number;
  sessionListView: SessionGroupHierarchyView;
}) {
  if (item.kind === "session") {
    return (
      <SessionListRow
        pageParams={{ sessionListView, sessionPage: returnPage }}
        session={item.session}
      />
    );
  }

  const workflowLabel = item.workflowLabels.join(", ") || "Not recorded";
  const agentLabel =
    item.agentIds
      .map((agentId) => agentDisplayNamesById.get(agentId) ?? agentId)
      .join(", ") || "Not recorded";
  const allSessionsHref = sessionListHref(returnPage, "groups", {
    expandedGroup: item.groupId,
    groupView: "all",
  });
  const needsReviewHref = sessionListHref(returnPage, "groups", {
    expandedGroup: item.groupId,
    groupView: "needs-review",
  });
  const humanConfirmedHref = sessionListHref(returnPage, "groups", {
    expandedGroup: item.groupId,
    groupView: "human-confirmed",
  });
  const toggleHref =
    expanded && groupView === "all"
      ? sessionListHref(returnPage, "groups")
      : allSessionsHref;
  const groupPageParams: SidebarPageParams = {
    expandedGroup: item.groupId,
    groupPage: groupMemberPage?.page,
    groupView,
    sessionListView: "groups",
    sessionPage: returnPage,
  };
  return (
    <section>
      <div className="grid min-h-16 min-w-0 items-center gap-2 px-4 py-3 transition-colors hover:bg-app-hover sm:grid-cols-[minmax(220px,300px)_120px_160px_130px_140px_150px_92px] sm:gap-4">
        <Link
          aria-expanded={expanded}
          className="grid min-w-0 gap-0.5 rounded-app-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          href={toggleHref}
          prefetch={false}
          scroll={false}
        >
          <span className="inline-flex min-w-0 items-center gap-2 truncate text-[13px] font-medium text-app-text">
            <ChevronRight
              className={cn(
                "h-4 w-4 shrink-0 text-app-text-faint transition-transform",
                expanded && "rotate-90",
              )}
              aria-hidden="true"
            />
            <span className="truncate" title={item.groupName}>
              {item.groupName}
            </span>
          </span>
          <span
            className="truncate pl-6 text-[10px] text-app-text-muted"
            title={`${workflowLabel} · ${agentLabel}`}
          >
            {workflowLabel} · {agentLabel}
          </span>
        </Link>
        <Badge tone="muted" dot>
          {item.sessionCount.toLocaleString("en-US")} Sessions
        </Badge>
        <SessionListProgress
          completedCount={item.completedSessionCount}
          percentage={completionPercentage(
            item.completedSessionCount,
            item.sessionCount,
          )}
          totalCount={item.sessionCount}
        />
        {item.needsReviewFindingCount > 0 ? (
          <Link
            aria-label={`View ${item.needsReviewFindingCount} Findings that need review`}
            className="rounded-app-sm outline-none transition-colors hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-ring/30"
            href={needsReviewHref}
            prefetch={false}
            scroll={false}
            title={`≥ ${findingReviewSeverityLabel(item.reviewMinSeverity)}: ${item.needsReviewFindingCount} Findings need review across ${item.needsReviewSessionCount} Sessions`}
          >
            <SessionNeedsReviewCount count={item.needsReviewFindingCount} />
          </Link>
        ) : (
          <SessionNeedsReviewCount count={item.needsReviewFindingCount} />
        )}
        <SessionHumanConfirmedCount count={item.humanConfirmedFindingCount} />
        <LocalDateTime
          className="font-mono text-[11px] text-app-text-muted"
          relativeDay
          value={item.createdAt}
        />
        <div className="flex items-center justify-end gap-1">
          <SessionGroupReviewSeverityButton
            groupId={item.groupId}
            groupName={item.groupName}
            key={`${item.groupId}:${item.reviewMinSeverity}`}
            value={item.reviewMinSeverity}
          />
          <HumanConfirmedFindingsExportButton
            compact
            count={item.humanConfirmedFindingCount}
            href={`/api/session-groups/${encodeURIComponent(item.groupId)}/human-confirmed-findings`}
          />
          <SessionGroupDeleteButton
            disabled={item.activeSessionCount > 0}
            groupId={item.groupId}
            groupName={item.groupName}
            sessionCount={item.sessionCount}
          />
        </div>
      </div>
      {expanded && groupMemberPage ? (
        <div className="border-t border-app-border-faint bg-app-surface-muted/40">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border-faint px-4 py-2.5 sm:pl-10">
            <SegmentedControl
              value={groupView}
              items={[
                {
                  count: item.needsReviewFindingCount,
                  href: needsReviewHref,
                  label: `Needs Review ≥ ${findingReviewSeverityLabel(item.reviewMinSeverity)}`,
                  value: "needs-review",
                },
                {
                  count: item.humanConfirmedFindingCount,
                  href: humanConfirmedHref,
                  label: "Human Confirmed",
                  value: "human-confirmed",
                },
                {
                  count: item.sessionCount,
                  href: allSessionsHref,
                  label: "All Sessions",
                  value: "all",
                },
              ]}
            />
            <span className="font-mono text-[11px] text-app-text-muted">
              {groupView === "needs-review"
                ? `${item.needsReviewFindingCount} Findings · ${item.needsReviewSessionCount} Sessions`
                : groupView === "human-confirmed"
                  ? `${item.humanConfirmedFindingCount} Findings · ${groupMemberPage.totalCount} Sessions`
                  : `${item.sessionCount.toLocaleString("en-US")} Sessions`}
            </span>
          </div>
          {groupMemberPage.items.length > 0 ? (
            <div className="divide-y divide-app-border-faint">
              {groupMemberPage.items.map((session) => (
                <SessionListRow
                  findingView={
                    groupView === "needs-review"
                      ? "needs-review"
                      : groupView === "human-confirmed"
                        ? "human-confirmed"
                        : "ai-confirmed"
                  }
                  indented
                  key={session.sessionId}
                  pageParams={groupPageParams}
                  session={session}
                />
              ))}
            </div>
          ) : (
            <div className="grid min-h-28 place-items-center px-4 py-6 text-center text-[12px] text-app-text-muted">
              {groupView === "needs-review"
                ? `This Group has no Findings that need review at the ≥ ${findingReviewSeverityLabel(item.reviewMinSeverity)} threshold.`
                : groupView === "human-confirmed"
                  ? "This Group has no Human Confirmed Findings."
                  : "This Group has no Sessions."}
            </div>
          )}
          <SessionGroupMemberPagination
            groupId={item.groupId}
            page={groupMemberPage.page}
            pageSize={groupMemberPage.pageSize}
            returnPage={returnPage}
            totalCount={groupMemberPage.totalCount}
            totalPages={groupMemberPage.totalPages}
            view={groupView}
          />
        </div>
      ) : null}
    </section>
  );
}

function SessionGroupMemberPagination({
  groupId,
  page,
  pageSize,
  returnPage,
  totalCount,
  totalPages,
  view,
}: {
  groupId: string;
  page: number;
  pageSize: number;
  returnPage: number;
  totalCount: number;
  totalPages: number;
  view: SessionGroupMemberView;
}) {
  if (totalPages <= 1) return null;

  const firstItem = (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, totalCount);
  const href = (targetPage: number) =>
    sessionListHref(returnPage, "groups", {
      expandedGroup: groupId,
      groupPage: targetPage,
      groupView: view,
    });

  return (
    <nav
      aria-label="Group Session pagination"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border-faint px-4 py-2.5 text-[11px] text-app-text-muted sm:pl-10"
    >
      <span className="font-mono">
        {firstItem}–{lastItem} / {totalCount} · Page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          disabled={page <= 1}
          href={page > 1 ? href(page - 1) : undefined}
          size="sm"
          variant="outline"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Previous
        </Button>
        <Button
          disabled={page >= totalPages}
          href={page < totalPages ? href(page + 1) : undefined}
          size="sm"
          variant="outline"
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

function SessionListRow({
  findingView = "ai-confirmed",
  indented = false,
  pageParams,
  session,
}: {
  findingView?: FindingView;
  indented?: boolean;
  pageParams: SidebarPageParams;
  session: SessionGroupHierarchySession;
}) {
  return (
    <Link
      className={cn(
        "grid min-h-16 min-w-0 items-center gap-2 px-4 py-3 transition-colors hover:bg-app-hover sm:grid-cols-[minmax(220px,300px)_120px_160px_130px_140px_150px_92px] sm:gap-4",
        indented && "pl-9 sm:pl-4",
      )}
      href={sessionHref({
        findingView,
        logView: "logs",
        pageParams,
        sessionId: session.sessionId,
        view: "findings",
      })}
      prefetch={false}
      scroll={false}
    >
      <div className={cn("grid min-w-0 gap-0.5", indented && "sm:pl-6")}>
        <span
          className="truncate text-[13px] font-medium text-app-text"
          title={sessionProjectName(session)}
        >
          {sessionProjectName(session)}
        </span>
        <span
          className="truncate font-mono text-[10px] text-app-text-muted"
          title={session.sessionId}
        >
          {session.sessionId}
        </span>
      </div>
      <SessionListStatus session={session} />
      <SessionFindingSummary
        centered={pageParams.sessionListView === "groups"}
        counts={session.findingSeverityCounts}
        pendingCount={session.pendingFindingCount}
      />
      <SessionNeedsReviewCount count={session.needsReviewFindingCount} />
      <SessionHumanConfirmedCount count={session.humanConfirmedFindingCount} />
      <LocalDateTime
        className="font-mono text-[11px] text-app-text-muted"
        relativeDay
        value={session.createdAt}
      />
    </Link>
  );
}

function SessionListStatus({
  session,
}: {
  session: SessionGroupHierarchySession;
}) {
  const progressPercentage =
    session.status === AuditStatus.RUNNING
      ? workflowProgress(session.workflowState).percentage
      : undefined;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge tone={displayStatusTone(session.status)} dot>
        {statusLabel(session.status)}
      </Badge>
      {progressPercentage !== undefined ? (
        <span className="font-mono text-[11px] text-app-primary">
          {formatProgressPercentage(progressPercentage)}
        </span>
      ) : null}
    </div>
  );
}

function SessionListProgress({
  completedCount,
  percentage,
  totalCount,
}: {
  completedCount?: number;
  percentage: number;
  totalCount?: number;
}) {
  const clampedPercentage = Math.max(0, Math.min(100, percentage));
  const completedTitle =
    completedCount === undefined || totalCount === undefined
      ? undefined
      : `${completedCount} / ${totalCount} Sessions completed`;

  return (
    <div className="mx-auto grid w-full max-w-28 gap-1" title={completedTitle}>
      <span className="text-center font-mono text-[11px] text-app-text-secondary">
        {formatProgressPercentage(clampedPercentage)}
      </span>
      <ProgressBar
        tone={clampedPercentage === 100 ? "success" : "primary"}
        value={clampedPercentage / 100}
      />
    </div>
  );
}

function SessionHumanConfirmedCount({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="text-center font-mono text-[11px] text-app-text-faint">
        0
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center justify-center gap-1 font-mono text-[11px] text-app-success"
      title="Manually confirmed Findings"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-app-success"
      />
      {count}
    </span>
  );
}

function SessionNeedsReviewCount({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="text-center font-mono text-[11px] text-app-text-faint">
        0
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center justify-center gap-1 font-mono text-[11px] text-app-primary"
      title="Findings that meet the current severity threshold and are not yet Human Confirmed or Rejected"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-app-primary"
      />
      {count}
    </span>
  );
}

function SessionFindingSummary({
  centered = false,
  counts,
  pendingCount,
}: {
  centered?: boolean;
  counts: SessionFindingSeverityCounts;
  pendingCount: number;
}) {
  const items = [
    { count: counts.critical, label: "Critical", tone: "critical" },
    { count: counts.high, label: "High", tone: "high" },
    { count: counts.medium, label: "Medium", tone: "medium" },
    { count: counts.low, label: "Low", tone: "low" },
    { count: counts.info, label: "Info", tone: "info" },
    { count: pendingCount, label: "Pending", tone: "muted" },
  ] as const;

  if (items.every((item) => item.count === 0)) {
    return (
      <span
        className={cn(
          "text-[12px] text-app-text-faint",
          centered && "text-center",
        )}
      >
        —
      </span>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-app-text-secondary",
        centered && "justify-center",
      )}
    >
      {items
        .filter((item) => item.count > 0)
        .map((item) => (
          <span className="inline-flex items-center gap-1" key={item.label}>
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                findingSummaryDotClass[item.tone],
              )}
            />
            <span title={item.label}>{item.count}</span>
          </span>
        ))}
    </div>
  );
}

const findingSummaryDotClass = {
  critical: "bg-finding-critical",
  high: "bg-finding-high",
  info: "bg-finding-info",
  low: "bg-finding-low",
  medium: "bg-finding-medium",
  muted: "bg-app-text-muted",
} as const;

function completionPercentage(completedCount: number, totalCount: number) {
  return totalCount === 0 ? 0 : (completedCount / totalCount) * 100;
}

function isActiveSessionListItem(session: SessionGroupHierarchySession) {
  return (
    session.status === AuditStatus.QUEUED ||
    session.status === AuditStatus.RUNNING
  );
}

function SessionPlaceholder() {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-8 text-center text-app-text-muted">
      <div className="grid justify-items-center gap-2">
        <FolderOpen className="h-6 w-6 text-app-text-faint" strokeWidth={1.5} />
        <h2 className="m-0 text-[14px] font-semibold text-app-text">
          Session not found
        </h2>
        <p className="m-0 text-[12px]">
          Return to the list and select a valid Session.
        </p>
      </div>
    </div>
  );
}

function SessionView({
  agentOptions,
  workflowOptions,
  details,
  findingView,
  progressPercentage,
  reviewError,
  reviewMinSeverity,
  sidebarPageParams,
  sessionActionError,
  view,
  logView,
}: {
  agentOptions: AuditAgentDefinition[];
  workflowOptions: WorkflowDefinitionSummary[];
  details: Awaited<ReturnType<typeof getSessionDetails>>;
  findingView: FindingView;
  progressPercentage: number;
  reviewError?: string;
  reviewMinSeverity: FindingReviewSeverity;
  sidebarPageParams: SidebarPageParams;
  sessionActionError?: string;
  view: MainView;
  logView: LogView;
}) {
  if (!details) return null;

  const pendingFindingItems: FindingItem[] = details.pendingFindings.map(
    (finding, index) => {
      const findingKey = findingKeyFor("pending", index, finding);
      return {
        finding,
        findingKey,
        humanStatus: finding.human_status,
        index,
        source: "pending",
        view: "pending",
      };
    },
  );
  const duplicateFindingItems: FindingItem[] = details.duplicateFindings.map(
    (finding, index) => ({
      finding,
      findingKey: `duplicate:${finding.id ?? index}`,
      index,
      source: "duplicate",
      view: "pending",
    }),
  );
  const pendingViewFindingItems = [
    ...pendingFindingItems,
    ...duplicateFindingItems,
  ];
  const confirmedFindingItems: FindingItem[] = details.findings.map(
    (finding, index) => {
      const findingKey = findingKeyFor("confirmed", index, finding);
      return {
        finding,
        findingKey,
        humanStatus: finding.human_status,
        index,
        source: "confirmed",
        view: "ai-confirmed",
      };
    },
  );
  const allFindingItems = [
    ...pendingFindingItems,
    ...duplicateFindingItems,
    ...confirmedFindingItems,
  ];
  const localConfirmedIds = new Set(
    details.localConfirmedFindings.map(({ id }) => String(id)),
  );
  const onchainConfirmedIds = new Set(
    details.onchainConfirmedFindings.map(({ id }) => String(id)),
  );
  const localConfirmedFindingItems = confirmedFindingItems
    .filter(({ finding }) => localConfirmedIds.has(String(finding.id)))
    .map((item) => ({ ...item, view: "ai-confirmed" as const }));
  const aiConfirmedFindingItems = localConfirmedFindingItems;
  const needsReviewFindingItems = localConfirmedFindingItems.filter(
    ({ finding, humanStatus }) =>
      humanStatus == null &&
      isFindingAtOrAboveReviewSeverity(finding.severity, reviewMinSeverity),
  );
  const onchainConfirmedFindingItems = confirmedFindingItems
    .filter(({ finding }) => onchainConfirmedIds.has(String(finding.id)))
    .map((item) => ({ ...item, view: "onchain-confirmed" as const }));
  const humanConfirmedFindingItems = [
    ...pendingFindingItems,
    ...confirmedFindingItems,
  ]
    .filter((item) => item.humanStatus === "tp")
    .map((item) => ({ ...item, view: "human-confirmed" as const }));
  const exportableHumanConfirmedFindingCount = [
    ...details.pendingFindings,
    ...details.findings,
  ].filter((finding) => finding.human_status === "tp").length;
  const humanRejectedFindingItems = [
    ...pendingFindingItems,
    ...confirmedFindingItems,
  ]
    .filter((item) => item.humanStatus === "fp")
    .map((item) => ({ ...item, view: "human-rejected" as const }));
  const duplicateGroups = details.duplicateGroups;
  const visibleFindings = (
    findingView === "all-findings"
      ? allFindingItems
      : findingView === "duplicate"
        ? duplicateFindingItems
        : findingView === "needs-review"
          ? needsReviewFindingItems
          : findingView === "human-confirmed"
            ? humanConfirmedFindingItems
            : findingView === "human-rejected"
              ? humanRejectedFindingItems
              : findingView === "onchain-confirmed"
                ? onchainConfirmedFindingItems
                : findingView === "duplicate-groups"
                  ? []
                  : aiConfirmedFindingItems
  ).sort(compareFindingItemsBySeverity);
  const sessionViewHref = (options: SessionHrefOptions) =>
    sessionHref({
      ...options,
      pageParams: sidebarPageParams,
    });
  const returnToSessionListHref = sessionListHref(
    sidebarPageParams.sessionPage ?? 1,
    sidebarPageParams.sessionListView,
    sidebarPageParams,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden fade-in-up">
      <div className="min-h-0 flex-1 overflow-y-auto p-5 [scrollbar-gutter:stable]">
        <div className="grid gap-4">
          <RunSummaryCard
            agentOptions={agentOptions}
            workflowOptions={workflowOptions}
            summary={details.summary}
            session={details.state}
            progressPercentage={progressPercentage}
            pendingCount={pendingViewFindingItems.length}
            duplicateGroupCount={duplicateGroups.length}
            localConfirmedCount={localConfirmedFindingItems.length}
            onchainConfirmedCount={onchainConfirmedFindingItems.length}
            humanConfirmedCount={humanConfirmedFindingItems.length}
            aiConfirmedCount={aiConfirmedFindingItems.length}
          />

          {sessionActionError ? (
            <div className="rounded-app border border-app-danger-border bg-app-danger-bg px-3 py-2 text-[12px] text-app-danger">
              {sessionActionError}
            </div>
          ) : null}

          <Card className={view === "logs" ? "overflow-visible" : undefined}>
            <CardHeader
              action={
                <div className="flex items-center gap-1.5">
                  <Tabs
                    value={view}
                    items={[
                      {
                        value: "findings",
                        label: "Findings",
                        href: sessionViewHref({
                          findingView,
                          logView,
                          sessionId: details.state.sessionId,
                          view: "findings",
                        }),
                        count: aiConfirmedFindingItems.length,
                      },
                      {
                        value: "workflow",
                        label: "Workflow",
                        href: sessionViewHref({
                          findingView,
                          logView,
                          sessionId: details.state.sessionId,
                          view: "workflow",
                        }),
                      },
                      {
                        value: "logs",
                        label: "Logs",
                        href: sessionViewHref({
                          findingView,
                          logView,
                          sessionId: details.state.sessionId,
                          view: "logs",
                        }),
                        count: details.totalLogCount,
                      },
                      {
                        value: "artifacts",
                        label: "Artifacts",
                        href: sessionViewHref({
                          findingView,
                          logView,
                          sessionId: details.state.sessionId,
                          view: "artifacts",
                        }),
                      },
                    ]}
                  />
                </div>
              }
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                {view === "findings" ? (
                  <FileWarning className="h-3.5 w-3.5" />
                ) : view === "logs" ? (
                  <ScrollText className="h-3.5 w-3.5" />
                ) : view === "workflow" ? (
                  <Workflow className="h-3.5 w-3.5" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5" />
                )}
                {view === "findings"
                  ? "Findings"
                  : view === "logs"
                    ? "Logs"
                    : view === "workflow"
                      ? "Workflow progress"
                      : "Artifacts"}
              </span>
            </CardHeader>

            <CardBody
              className={
                view === "artifacts" || view === "workflow"
                  ? "h-[calc(100dvh-260px)] min-h-[460px] p-0"
                  : "grid gap-2"
              }
            >
              {view === "findings" ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <SegmentedControl
                        value={findingView}
                        items={[
                          {
                            value: "needs-review",
                            label: `Needs Review ≥ ${findingReviewSeverityLabel(reviewMinSeverity)}`,
                            count: needsReviewFindingItems.length,
                            href: sessionViewHref({
                              findingView: "needs-review",
                              logView,
                              sessionId: details.state.sessionId,
                              view: "findings",
                            }),
                          },
                          {
                            value: "all-findings",
                            label: "All Finding",
                            count: allFindingItems.length,
                            href: sessionViewHref({
                              findingView: "all-findings",
                              logView,
                              sessionId: details.state.sessionId,
                              view: "findings",
                            }),
                          },
                          {
                            value: "duplicate",
                            label: "Duplicate",
                            count: duplicateFindingItems.length,
                            href: sessionViewHref({
                              findingView: "duplicate",
                              logView,
                              sessionId: details.state.sessionId,
                              view: "findings",
                            }),
                          },
                          {
                            value: "ai-confirmed",
                            label: "AI Confirm",
                            count: aiConfirmedFindingItems.length,
                            href: sessionViewHref({
                              findingView: "ai-confirmed",
                              logView,
                              sessionId: details.state.sessionId,
                              view: "findings",
                            }),
                          },
                          {
                            value: "onchain-confirmed",
                            label: "Onchain Confirm",
                            count: onchainConfirmedFindingItems.length,
                            href: sessionViewHref({
                              findingView: "onchain-confirmed",
                              logView,
                              sessionId: details.state.sessionId,
                              view: "findings",
                            }),
                          },
                        ]}
                      />
                      <SegmentedControl
                        value={findingView}
                        items={[
                          {
                            value: "human-confirmed",
                            label: "Human Confirmed",
                            count: humanConfirmedFindingItems.length,
                            href: sessionViewHref({
                              findingView: "human-confirmed",
                              logView,
                              sessionId: details.state.sessionId,
                              view: "findings",
                            }),
                          },
                          {
                            value: "human-rejected",
                            label: "Human Rejected",
                            count: humanRejectedFindingItems.length,
                            href: sessionViewHref({
                              findingView: "human-rejected",
                              logView,
                              sessionId: details.state.sessionId,
                              view: "findings",
                            }),
                          },
                        ]}
                      />
                    </div>
                    <HumanConfirmedFindingsExportButton
                      count={exportableHumanConfirmedFindingCount}
                      href={`/api/sessions/${encodeURIComponent(details.state.sessionId)}/human-confirmed-findings`}
                    />
                  </div>

                  {reviewError ? (
                    <div className="rounded-app-sm border border-app-danger-border bg-app-danger-bg px-2 py-1.5 text-[12px] text-app-danger">
                      {reviewError}
                    </div>
                  ) : null}

                  {findingView === "duplicate-groups" ? (
                    <DuplicateFindingGroupsView groups={duplicateGroups} />
                  ) : visibleFindings.length > 0 ? (
                    <div className="grid gap-1.5">
                      {visibleFindings.map(
                        ({
                          finding,
                          findingKey,
                          humanStatus,
                          source,
                          view: itemView,
                        }) => (
                          <FindingRow
                            key={`${source}:${finding.id ?? findingKey}`}
                            finding={finding}
                            findingKey={findingKey}
                            mode={itemView}
                            readOnly={source === "duplicate"}
                            humanStatus={humanStatus}
                            sessionId={details.state.sessionId}
                          />
                        ),
                      )}
                    </div>
                  ) : (
                    <div className="grid place-items-center gap-3 px-3 py-6 text-center text-[12px] text-app-text-muted">
                      <span>
                        {findingView === "needs-review"
                          ? "Review is complete for this Session."
                          : "No Findings yet"}
                      </span>
                      {findingView === "needs-review" ? (
                        <Button
                          href={returnToSessionListHref}
                          size="sm"
                          variant="outline"
                        >
                          Back to Needs Review
                        </Button>
                      ) : null}
                    </div>
                  )}
                </>
              ) : view === "logs" ? (
                <SessionLogViewer
                  aiHref={sessionViewHref({
                    findingView,
                    sessionId: details.state.sessionId,
                    view: "logs",
                    logView: "logs",
                  })}
                  initialLogs={details.logs}
                  initialOffset={details.logOffset}
                  initialTotalLogCount={details.totalLogCount}
                  key={`${details.state.sessionId}:${logView}`}
                  logView={logView}
                  rawHref={sessionViewHref({
                    findingView,
                    sessionId: details.state.sessionId,
                    view: "logs",
                    logView: "raw-logs",
                  })}
                  sessionId={details.state.sessionId}
                  textHref={sessionLogTextHref(details.state.sessionId)}
                />
              ) : view === "workflow" ? (
                <SessionWorkflowViewer
                  agents={details.state.agents}
                  initialSessionStatus={details.state.status}
                  initialWorkflowState={details.state.workflowState}
                  key={details.state.sessionId}
                  sessionId={details.state.sessionId}
                  workflowDefinition={details.state.workflow.toJSON()}
                />
              ) : (
                <SessionArtifactsBrowser
                  className="h-full"
                  key={details.state.sessionId}
                  sessionId={details.state.sessionId}
                />
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function RunSummaryCard({
  aiConfirmedCount,
  agentOptions,
  workflowOptions,
  localConfirmedCount,
  duplicateGroupCount,
  humanConfirmedCount,
  onchainConfirmedCount,
  pendingCount,
  progressPercentage,
  session,
  summary,
}: {
  aiConfirmedCount: number;
  agentOptions: AuditAgentDefinition[];
  workflowOptions: WorkflowDefinitionSummary[];
  localConfirmedCount: number;
  duplicateGroupCount: number;
  humanConfirmedCount: number;
  onchainConfirmedCount: number;
  pendingCount: number;
  progressPercentage: number;
  session: AuditSessionSnapshot;
  summary: RunSummary | null;
}) {
  const displayedStatusLabel = statusLabel(session.status);
  const displayedStatusTone = displayStatusTone(session.status);
  return (
    <Card>
      <CardHeader
        action={
          <SessionSummaryActions
            agentOptions={agentOptions}
            session={session}
            workflowOptions={workflowOptions}
          />
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5" />
          Session summary
        </span>
      </CardHeader>
      <CardBody className="py-1.5">
        <div className="grid divide-y divide-app-border-faint">
          <SummaryLine
            label="Session"
            items={[
              {
                label: "Status",
                hideLabel: true,
                value: (
                  <Badge tone={displayedStatusTone} dot>
                    {displayedStatusLabel}
                  </Badge>
                ),
                title: displayedStatusLabel,
              },
              {
                label: "Progress",
                value: formatProgressPercentage(progressPercentage),
                mono: true,
                tone: session.status === "completed" ? "success" : "primary",
              },
              {
                label: "Project",
                value: sessionProjectName(session),
                mono: true,
              },
              ...(session.source
                ? [{ label: "Source", value: session.source, mono: true }]
                : []),
              {
                label: "Created",
                value: <LocalDateTime relativeDay value={session.createdAt} />,
              },
              ...(session.startedAt
                ? [
                    {
                      label: "Started",
                      value: (
                        <LocalDateTime relativeDay value={session.startedAt} />
                      ),
                    },
                    {
                      label: "Duration",
                      value: sessionDuration(session),
                      mono: true,
                    },
                  ]
                : []),
              ...(session.finishedAt
                ? [
                    {
                      label: "Ended",
                      value: (
                        <LocalDateTime relativeDay value={session.finishedAt} />
                      ),
                    },
                  ]
                : []),
            ]}
          />
          <SummaryLine
            label="Target information"
            items={targetSummaryItems(session)}
          />
          <SummaryLine
            label="AI / Token"
            items={[
              {
                label: "Input",
                value: summary ? formatTokens(summary.inputTokens) : "n/a",
                mono: true,
              },
              {
                label: "Output",
                value: summary ? formatTokens(summary.outputTokens) : "n/a",
                mono: true,
              },
              {
                label: "Cache read",
                value: summary
                  ? formatTokens(summary.cacheReadInputTokens)
                  : "n/a",
                mono: true,
              },
              {
                label: "Reasoning",
                value: summary
                  ? formatTokens(summary.reasoningOutputTokens)
                  : "n/a",
                mono: true,
              },
              {
                label: "Total",
                value: summary ? formatTokens(totalTokens(summary)) : "n/a",
                mono: true,
                tone: "primary",
              },
              {
                label: "Cost",
                value: summary ? formatCost(summary.totalCostUsd) : "n/a",
                mono: true,
                tone: "primary",
              },
              {
                label: "Workflow",
                value: session.workflowId,
                mono: true,
              },
              {
                label: "Agent",
                value:
                  session.agents.join(", ") ||
                  "Not recorded for legacy Session",
                mono: true,
                wrap: true,
              },
            ]}
          />
          <SummaryLine
            label="Findings"
            items={[
              {
                label: "Pending",
                value: pendingCount,
                mono: true,
                tone: "warning",
              },
              {
                label: "Duplicate Groups",
                value: duplicateGroupCount,
                mono: true,
                tone: "danger",
              },
              {
                label: "Local Confirm",
                value: localConfirmedCount,
                mono: true,
                tone: "success",
              },
              {
                label: "AI Confirm",
                value: aiConfirmedCount,
                mono: true,
                tone: "primary",
              },
              {
                label: "Onchain Confirm",
                value: onchainConfirmedCount,
                mono: true,
                tone: "success",
              },
              {
                label: "Human Confirmed",
                value: humanConfirmedCount,
                mono: true,
                tone: "success",
              },
            ]}
          />
          {hasMetadataEntries(session.metadata) ? (
            <MetadataSummaryLine
              entries={metadataSummaryEntries(session.metadata)}
            />
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

const targetMetadataFieldGroups = [
  {
    label: "Chain",
    keys: ["chain_key", "chain", "chain_info_id", "chain_id", "chainId"],
  },
  {
    label: "Address",
    keys: [
      "contract",
      "address",
      "target_address",
      "targetAddress",
      "address_id",
    ],
  },
  {
    label: "Source URL",
    keys: [
      "scan_source_contract",
      "implementation_address",
      "implementationAddress",
    ],
  },
  {
    label: "Address type",
    keys: ["address_type", "addressType"],
  },
  {
    label: "Beneficiary address",
    keys: [
      "beneficiary_address",
      "beneficiaryAddress",
      "beneficiary",
      "fee_recipient",
      "feeRecipient",
      "profit_address",
      "profitAddress",
      "revenue_address",
      "revenueAddress",
    ],
  },
  {
    label: "Contract name",
    keys: ["contract_name", "contractName"],
  },
  {
    label: "Source path",
    keys: ["scan_source_path", "source_path", "sourcePath"],
  },
  {
    label: "Proxy implementation",
    keys: ["scan_uses_proxy_implementation", "is_proxy", "isProxy"],
  },
] as const;

const targetMetadataKeys: ReadonlySet<string> = new Set(
  targetMetadataFieldGroups.flatMap((group) => [...group.keys]),
);

function targetSummaryItems(session: AuditSessionSnapshot): SummaryLineItem[] {
  const seenValues = new Set<string>();
  const workingDirectory = session.workingDirectory ?? session.targetPath;

  return [
    {
      label: "Path",
      value: workingDirectory,
      mono: true,
      title: workingDirectory,
      wrap: true,
    },
    ...targetMetadataSummaryItems(session.metadata, seenValues),
  ];
}

function targetMetadataSummaryItems(
  metadata: AuditSessionSnapshot["metadata"],
  seenValues: Set<string>,
): SummaryLineItem[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }

  const metadataRecord = metadata as Record<string, unknown>;

  return targetMetadataFieldGroups.flatMap((group) => {
    for (const key of group.keys) {
      const value = metadataRecord[key];
      const formatted = formatInlineMetadataValue(value, key);
      if (!formatted) {
        continue;
      }

      const normalized = formatted.toLowerCase();
      if (seenValues.has(normalized)) {
        continue;
      }
      seenValues.add(normalized);

      return [
        {
          label: group.label,
          value: formatted,
          mono: true,
          title: formatted,
          wrap: true,
        },
      ];
    }

    return [];
  });
}

function formatInlineMetadataValue(value: unknown, key: string) {
  if (value === undefined || value === null || Array.isArray(value)) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (typeof value === "number") {
    if (key === "address_type" || key === "addressType") {
      return value === 1 ? "token" : value === 2 ? "contract" : String(value);
    }

    if (key === "is_proxy") {
      return value === 1 ? "Yes" : value === 0 ? "No" : String(value);
    }

    return Number.isFinite(value) ? String(value) : undefined;
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return undefined;
}

function SessionSummaryActions({
  agentOptions,
  session,
  workflowOptions,
}: {
  agentOptions: AuditAgentDefinition[];
  session: AuditSessionSnapshot;
  workflowOptions: WorkflowDefinitionSummary[];
}) {
  const queued = session.status === "queued";
  const running = session.status === "running";
  const active = queued || running;

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {queued ? <SessionDequeueButton sessionId={session.sessionId} /> : null}
      {running ? <SessionStopButton sessionId={session.sessionId} /> : null}
      <SessionRerunButton
        agentOptions={agentOptions}
        currentAgentIds={session.agents}
        currentWorkflowId={session.workflowId}
        disabled={active}
        workflowOptions={workflowOptions}
        sessionId={session.sessionId}
      />
      <SessionDeleteButton disabled={active} sessionId={session.sessionId} />
    </div>
  );
}

function hasMetadataEntries(metadata: AuditSessionSnapshot["metadata"]) {
  return metadataSummaryEntries(metadata).length > 0;
}

function metadataSummaryEntries(metadata: AuditSessionSnapshot["metadata"]) {
  return Object.entries(metadata ?? {}).filter(
    ([key]) => !targetMetadataKeys.has(key),
  );
}

type SummaryTone =
  "default" | "danger" | "info" | "primary" | "success" | "warning";

type SummaryLineItem = {
  label: string;
  hideLabel?: boolean;
  mono?: boolean;
  title?: string;
  tone?: SummaryTone;
  value: ReactNode;
  wide?: boolean;
  wrap?: boolean;
};

function SummaryLine({
  items,
  label,
}: {
  items: SummaryLineItem[];
  label: string;
}) {
  return (
    <section className="grid gap-1.5 py-2 md:grid-cols-[72px_minmax(0,1fr)]">
      <div className="pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
        {label}
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1.5">
        {items.map((item) => (
          <SummaryInlineItem key={item.label} item={item} />
        ))}
      </div>
    </section>
  );
}

function SummaryInlineItem({ item }: { item: SummaryLineItem }) {
  const toneClass = {
    default: "text-app-text",
    danger: "text-app-danger",
    info: "text-app-info",
    primary: "text-app-primary",
    success: "text-app-success",
    warning: "text-app-warning",
  }[item.tone ?? "default"];
  const title =
    item.title ??
    (typeof item.value === "string" || typeof item.value === "number"
      ? String(item.value)
      : undefined);

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1.5 text-[12px] leading-tight",
        item.wide ? "basis-full xl:basis-auto xl:flex-1" : "shrink-0",
      )}
    >
      {item.hideLabel ? null : (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-app-text-muted">
          {item.label}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 font-semibold",
          item.mono ? "font-mono" : "",
          item.wrap ? "break-all" : "truncate",
          toneClass,
        )}
        title={title}
      >
        {item.value}
      </span>
    </span>
  );
}

function FindingRow({
  finding,
  findingKey,
  humanStatus,
  mode,
  readOnly = false,
  sessionId,
}: {
  finding: Finding;
  findingKey: string;
  humanStatus?: HumanFindingStatus | null;
  mode: FindingItemView;
  readOnly?: boolean;
  sessionId: string;
}) {
  return (
    <article className="grid gap-1.5 rounded-app border border-app-border-faint bg-app-surface px-3 py-2">
      <FindingInteractions
        duplicateOfId={finding.duplicate_of_id}
        findingId={finding.id}
        findingKey={findingKey}
        findingTitle={finding.title}
        findingView={mode}
        initialHumanStatus={humanStatus}
        initialNote={finding.note}
        readOnly={readOnly}
        sessionId={sessionId}
      />
      <FindingDetails finding={finding} />
    </article>
  );
}

function FindingDetails({ finding }: { finding: Finding }) {
  return (
    <div className="grid gap-1.5 text-[12px] leading-snug">
      <FindingDetailRow
        label="Severity"
        value={<SeverityBadge severity={finding.severity} />}
      />
      {finding.duplicate_of_id ? (
        <FindingDetailRow
          label="Duplicate Of"
          mono
          value={`#${finding.duplicate_of_id}`}
        />
      ) : null}
      <FindingDetailRow label="File Path" mono value={finding.file_path} />
      <FindingDetailSection label="Root Cause">
        <Markdown>{finding.root_cause || "n/a"}</Markdown>
      </FindingDetailSection>
      <FindingDetailSection label="Impact">
        <Markdown>{finding.impact || "n/a"}</Markdown>
      </FindingDetailSection>
      {finding.trigger_conditions ? (
        <FindingDetailSection label="Trigger Conditions">
          <Markdown>{finding.trigger_conditions}</Markdown>
        </FindingDetailSection>
      ) : null}
      {finding.economic_impact ? (
        <FindingDetailSection label="Economic Impact">
          <Markdown>{finding.economic_impact}</Markdown>
        </FindingDetailSection>
      ) : null}
      {finding.confirmation_reason ? (
        <FindingDetailSection label="Confirmation Reason">
          <Markdown>{finding.confirmation_reason}</Markdown>
        </FindingDetailSection>
      ) : null}
      {finding.rejection_reason ? (
        <FindingDetailSection label="Rejection Reason">
          <Markdown>{finding.rejection_reason}</Markdown>
        </FindingDetailSection>
      ) : null}
      <FindingDetailSection label="Description">
        <Markdown>{finding.description || "n/a"}</Markdown>
      </FindingDetailSection>
      <FindingDetailSection label="Recommendation">
        {finding.recommendation ? (
          <Markdown>{finding.recommendation}</Markdown>
        ) : (
          <span className="text-app-text-muted">n/a</span>
        )}
      </FindingDetailSection>
      <FindingDetailSection label="Source Locations">
        {finding.source_locations && finding.source_locations.length > 0 ? (
          <div className="grid gap-1">
            {finding.source_locations.map((location, index) => (
              <div
                className="grid gap-1 rounded-app-sm border border-app-border-faint bg-app-surface-muted px-2 py-1.5"
                key={`${location.file}-${location.start_line}-${index}`}
              >
                <div className="break-all font-mono text-[11px] text-app-text">
                  {formatSourceLocation(location)}
                </div>
                {location.snippet ? (
                  <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-app-sm bg-app-surface px-2 py-1 font-mono text-[11px] leading-snug text-app-text-secondary">
                    {location.snippet}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <span className="text-app-text-muted">n/a</span>
        )}
      </FindingDetailSection>
      <FindingDetailSection label="Triggered Actor">
        {finding.triggered_actor ? (
          <Markdown>{finding.triggered_actor}</Markdown>
        ) : (
          <span className="text-app-text-muted">n/a</span>
        )}
      </FindingDetailSection>
    </div>
  );
}

function FindingDetailRow({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: ReactNode;
}) {
  return (
    <div className="grid gap-1 md:grid-cols-[112px_minmax(0,1fr)]">
      <div className="text-[11px] font-medium text-app-text-muted">{label}</div>
      <div
        className={cn(
          "min-w-0 break-words text-app-text-secondary",
          mono ? "font-mono text-[11px]" : "",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function FindingDetailSection({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <section className="grid gap-1 md:grid-cols-[112px_minmax(0,1fr)]">
      <div className="text-[11px] font-medium text-app-text-muted">{label}</div>
      <div className="min-w-0 text-app-text-secondary">{children}</div>
    </section>
  );
}

function formatSourceLocation(
  location: NonNullable<Finding["source_locations"]>[number],
) {
  const endLine =
    typeof location.end_line === "number" ? `-${location.end_line}` : "";
  return `${location.file}:${location.start_line}${endLine}`;
}

function DuplicateFindingGroupsView({
  groups,
}: {
  groups: SessionDuplicateFindingGroup[];
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-app border border-app-border-faint bg-app-surface px-3 py-2 text-[12px] text-app-text-muted">
        No duplicate groups.
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {groups.map((group) => {
        const canonical = group.canonicalFinding;
        return (
          <section
            className="grid gap-3 rounded-app border border-app-border-faint bg-app-surface p-3"
            key={group.duplicateOfId}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone="primary">Canonical finding</Badge>
                  <span className="font-mono text-[11px] text-app-text-muted">
                    #{group.duplicateOfId}
                  </span>
                  {canonical ? (
                    <SeverityBadge severity={canonical.severity} />
                  ) : null}
                </div>
                <FindingPointerSummary
                  fallbackMeta={String(group.duplicateOfId)}
                  fallbackTitle="Canonical finding not found"
                  finding={canonical}
                  strong
                />
                {canonical?.root_cause ? (
                  <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-app-text-secondary">
                    {canonical.root_cause}
                  </p>
                ) : null}
              </div>
              <Badge tone="warning">
                {group.duplicateFindings.length} duplicates
              </Badge>
            </div>

            <div className="grid gap-1.5 border-t border-app-border-faint pt-2.5">
              <div className="text-[11px] font-medium text-app-text-muted">
                Duplicate reports pointing to #{group.duplicateOfId}
              </div>
              {group.duplicateFindings.map((finding, index) => (
                <div
                  className="grid min-w-0 gap-1 rounded-app-sm border border-app-border-faint bg-app-surface-muted px-2.5 py-2 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center"
                  key={finding.id ?? `${group.duplicateOfId}-${index}`}
                >
                  <span className="font-mono text-[11px] text-app-text-muted">
                    #{finding.id ?? index + 1}
                  </span>
                  <FindingPointerSummary finding={finding} />
                  <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
                    <SeverityBadge severity={finding.severity} />
                    <Badge tone="muted">→ #{group.duplicateOfId}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function FindingPointerSummary({
  fallbackMeta,
  fallbackTitle = "n/a",
  finding,
  strong = false,
}: {
  fallbackMeta?: string;
  fallbackTitle?: string;
  finding?: Finding;
  strong?: boolean;
}) {
  const title = finding?.title ?? fallbackTitle;
  const meta = finding?.file_path ?? fallbackMeta;

  return (
    <div className="min-w-0">
      <div
        className={cn(
          "truncate text-[12px]",
          strong ? "font-medium text-app-text" : "text-app-text-secondary",
        )}
        title={title}
      >
        {title}
      </div>
      {meta ? (
        <div
          className="truncate font-mono text-[11px] text-app-text-muted"
          title={meta}
        >
          {meta}
        </div>
      ) : null}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Finding["severity"] }) {
  return (
    <Badge tone={findingSeverityTone(severity)} dot>
      {severityLabel(severity)}
    </Badge>
  );
}

type DisplayStatus = AuditSessionSnapshot["status"];

function statusLabel(status: DisplayStatus) {
  return (
    {
      completed: "Completed",
      failed: "Failed",
      interrupted: "Interrupted",
      queued: "Queued",
      running: "Running",
      wait: "Waiting",
    } as const
  )[status];
}

function displayStatusTone(status: DisplayStatus) {
  return (
    {
      completed: "success",
      failed: "danger",
      interrupted: "warning",
      queued: "muted",
      running: "info",
      wait: "muted",
    } as const
  )[status];
}

function formatProgressPercentage(value: number) {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function sessionDuration(session: AuditSessionSnapshot) {
  if (!session.startedAt) return "n/a";

  const startedAt = Date.parse(session.startedAt);
  const finishedAt = Date.parse(session.finishedAt ?? new Date().toISOString());
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return "n/a";

  return formatDuration(Math.max(0, finishedAt - startedAt));
}

function sessionProjectName(session: AuditSessionSnapshot) {
  return session.projectName || session.sessionId;
}

function severityLabel(severity: Finding["severity"]) {
  return severity;
}

function compareFindingItemsBySeverity(left: FindingItem, right: FindingItem) {
  const severityDelta =
    severityRank(right.finding.severity) - severityRank(left.finding.severity);
  if (severityDelta !== 0) return severityDelta;
  return left.index - right.index;
}

function severityRank(severity: Finding["severity"]) {
  return (
    {
      info: 0,
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    } as const
  )[severity];
}

type SessionHrefOptions = {
  findingView: FindingView;
  logView: LogView;
  sessionId: string;
  view: MainView;
};

function sessionHref({
  findingView,
  logView,
  pageParams,
  sessionId,
  view,
}: SessionHrefOptions & {
  pageParams?: SidebarPageParams;
}) {
  const params = new URLSearchParams({ view });
  if (view === "logs") params.set("logView", logView);
  if (view === "findings") {
    params.set("findingView", findingView);
  }
  appendSidebarPageParams(params, pageParams);
  return appendQueryString(sessionPagePath(sessionId), params);
}

function sessionListHref(
  page: number,
  sessionListView: SessionGroupHierarchyView = "sessions",
  pageParams?: SidebarPageParams,
) {
  const params = new URLSearchParams();
  appendSidebarPageParams(params, {
    ...pageParams,
    sessionListView,
    sessionPage: page,
  });
  return appendQueryString(sessionsPagePath(), params);
}

function sessionLogTextHref(sessionId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/logs?format=text&source=agent`;
}

type SidebarPageParams = {
  expandedGroup?: string;
  groupPage?: number;
  groupView?: SessionGroupMemberView;
  sessionListView?: SessionGroupHierarchyView;
  sessionPage?: number;
};

function shouldRedirectToCanonicalDashboardHref({
  findingView,
  logView,
  params,
  requestedSidebarPageParams,
  resource,
  view,
}: {
  findingView: FindingView;
  logView: LogView;
  params?: DashboardPageSearchParams;
  requestedSidebarPageParams: SidebarPageParams;
  resource?: DashboardResource;
  view: MainView;
}) {
  if (!hasCanonicalSidebarParams(params, requestedSidebarPageParams)) {
    return true;
  }

  if (resource?.type !== "session") {
    return Boolean(
      params?.findingReviewError ||
      params?.findingView ||
      params?.logView ||
      params?.sessionActionError ||
      params?.view,
    );
  }

  if (params?.view !== view) return true;

  if (view === "findings") {
    return params?.findingView !== findingView || params?.logView !== undefined;
  }

  if (view === "logs") {
    return (
      params?.findingReviewError !== undefined ||
      params?.findingView !== undefined ||
      params?.logView !== logView
    );
  }

  return (
    params?.findingReviewError !== undefined ||
    params?.findingView !== undefined ||
    params?.logView !== undefined
  );
}

function canonicalDashboardHref({
  findingView,
  logView,
  params,
  requestedSidebarPageParams,
  resource,
  view,
}: {
  findingView: FindingView;
  logView: LogView;
  params?: DashboardPageSearchParams;
  requestedSidebarPageParams: SidebarPageParams;
  resource?: DashboardResource;
  view: MainView;
}) {
  const nextParams = new URLSearchParams();

  appendOptionalSearchParam(
    nextParams,
    "createdSessionId",
    params?.createdSessionId,
  );
  appendOptionalSearchParam(nextParams, "uploadError", params?.uploadError);
  appendSidebarPageParams(nextParams, requestedSidebarPageParams);

  if (resource?.type !== "session") {
    return appendQueryString(sessionsPagePath(), nextParams);
  }

  nextParams.set("view", view);
  appendOptionalSearchParam(
    nextParams,
    "sessionActionError",
    params?.sessionActionError,
  );

  if (view === "findings") {
    nextParams.set("findingView", findingView);
    appendOptionalSearchParam(
      nextParams,
      "findingReviewError",
      params?.findingReviewError,
    );
  } else if (view === "logs") {
    nextParams.set("logView", logView);
  }

  return appendQueryString(sessionPagePath(resource.id), nextParams);
}

function appendOptionalSearchParam(
  params: URLSearchParams,
  key: keyof DashboardPageSearchParams,
  value?: string,
) {
  if (value) params.set(key, value);
}

function appendSidebarPageParams(
  params: URLSearchParams,
  pageParams?: SidebarPageParams,
) {
  if (pageParams?.sessionPage && pageParams.sessionPage > 1) {
    params.set("sessionPage", String(pageParams.sessionPage));
  }
  if (pageParams?.sessionListView === "groups") {
    params.set("sessionListView", "groups");
  }
  const expandedGroup =
    pageParams?.sessionListView === "groups"
      ? normalizedOptionalString(pageParams.expandedGroup)
      : undefined;
  if (expandedGroup) {
    params.set("expandedGroup", expandedGroup);
    if (pageParams?.groupPage && pageParams.groupPage > 1) {
      params.set("groupPage", String(pageParams.groupPage));
    }
    if (pageParams?.groupView && pageParams.groupView !== "all") {
      params.set("groupView", pageParams.groupView);
    }
  }
}

function hasCanonicalSidebarParams(
  params: DashboardPageSearchParams | undefined,
  pageParams: SidebarPageParams,
) {
  const canonical = new URLSearchParams();
  appendSidebarPageParams(canonical, pageParams);
  return (
    params?.sessionPage === (canonical.get("sessionPage") ?? undefined) &&
    params?.sessionListView ===
      (canonical.get("sessionListView") ?? undefined) &&
    params?.expandedGroup === (canonical.get("expandedGroup") ?? undefined) &&
    params?.groupPage === (canonical.get("groupPage") ?? undefined) &&
    params?.groupView === (canonical.get("groupView") ?? undefined)
  );
}

function hasGroupListParams(params?: DashboardPageSearchParams) {
  return Boolean(
    params?.expandedGroup || params?.groupPage || params?.groupView,
  );
}

function canonicalPageParam(page: number) {
  return page > 1 ? String(page) : undefined;
}

function canonicalGroupViewParam(view: SessionGroupMemberView) {
  return view === "all" ? undefined : view;
}

function normalizedOptionalString(value?: string) {
  return value?.trim() || undefined;
}

function parsePageNumber(value?: string) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function parseSessionListView(value?: string): SessionGroupHierarchyView {
  return value === "groups" ? "groups" : "sessions";
}

function parseSessionGroupMemberView(value?: string): SessionGroupMemberView {
  return value === "needs-review" || value === "human-confirmed"
    ? value
    : "all";
}

function parseMainView(value?: string): MainView {
  if (value === "workflow" || value === "logs" || value === "artifacts") {
    return value;
  }
  return "findings";
}

function parseLogView(value?: string): LogView {
  if (value === "raw-logs") return "raw-logs";
  return "logs";
}
