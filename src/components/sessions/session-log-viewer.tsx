"use client";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/components/ui/cn";
import { LocalDateTime } from "@/app/components/ui/local-date-time";
import { SegmentedControl } from "@/app/components/ui/segmented-control";
import {
  agentLogMessage,
  agentToolCategory,
  type AgentToolCategory,
} from "@/lib/agent-log";
import type { LogEntry } from "@/server/sessions";
import {
  Bot,
  Brain,
  ChevronRight,
  ScrollText,
  TerminalSquare,
  UserRound,
  Wifi,
  WifiOff,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

type LogView = "logs" | "raw-logs";
type LogKind =
  "assistant" | "program" | "raw" | "thinking" | "tool-call" | "user";
type CompactLogKind = Extract<LogKind, "program" | "raw" | "tool-call">;
type StreamStatus = "connecting" | "live" | "reconnecting" | "unavailable";
const logStreamPayloadSchema = z
  .object({
    logs: z.array(z.record(z.string(), z.unknown())),
    offset: z.number().optional(),
    size: z.number().optional(),
  })
  .passthrough();

const tailErrorPayloadSchema = z
  .object({
    message: z.string(),
  })
  .passthrough();

const logsResponseSchema = z
  .object({
    logOffset: z.number().optional(),
    logs: z.array(z.record(z.string(), z.unknown())),
    returnedLogCount: z.number().optional(),
    totalLogCount: z.number().optional(),
  })
  .passthrough();

export function SessionLogViewer({
  aiHref,
  initialLogs,
  initialOffset,
  initialTotalLogCount,
  logView,
  rawHref,
  sessionId,
  textHref,
}: {
  aiHref: string;
  initialLogs: LogEntry[];
  initialOffset: number;
  initialTotalLogCount: number;
  logView: LogView;
  rawHref: string;
  sessionId: string;
  textHref: string;
}) {
  const [logs, setLogs] = useState(() => initialLogs);
  const [totalLogCount, setTotalLogCount] = useState(initialTotalLogCount);
  const [streamOffset, setStreamOffset] = useState(initialOffset);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [loadAllError, setLoadAllError] = useState<string | null>(null);
  const [loadingAllLogs, setLoadingAllLogs] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      const timeoutId = window.setTimeout(() => {
        setStreamStatus("unavailable");
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }

    let active = true;
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/logs?format=stream&source=agent&after=${streamOffset}`;
    const source = new EventSource(url);

    source.addEventListener("ready", () => {
      if (active) setStreamStatus("live");
    });

    source.addEventListener("logs", (event) => {
      if (!active) return;
      try {
        const payload = logStreamPayloadSchema.parse(JSON.parse(event.data));
        if (payload.logs.length === 0) return;
        setLogs((current) => [...current, ...(payload.logs as LogEntry[])]);
        setTotalLogCount((current) => current + payload.logs.length);
        setStreamStatus("live");
        setStreamError(null);
      } catch (error) {
        setStreamError(errorMessage(error));
      }
    });

    source.addEventListener("rotated", () => {
      if (!active) return;
      setLogs([]);
      setTotalLogCount(0);
      setStreamStatus("live");
    });

    source.addEventListener("tail-error", (event) => {
      if (!active) return;
      try {
        const payload = tailErrorPayloadSchema.parse(JSON.parse(event.data));
        setStreamError(payload.message);
      } catch (error) {
        setStreamError(errorMessage(error));
      }
    });

    source.onerror = () => {
      if (active) setStreamStatus("reconnecting");
    };

    return () => {
      active = false;
      source.close();
    };
  }, [logView, sessionId, streamOffset]);

  const loadAllLogs = useCallback(async () => {
    setLoadingAllLogs(true);
    setLoadAllError(null);
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/logs?limit=all&source=agent`,
        {
          headers: {
            Accept: "application/json",
          },
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to load logs: ${response.status}`);
      }

      const payload = logsResponseSchema.parse(await response.json());
      const nextLogs = payload.logs as LogEntry[];
      setLogs(nextLogs);
      setTotalLogCount(payload.totalLogCount ?? nextLogs.length);
      if (typeof payload.logOffset === "number") {
        setStreamOffset(payload.logOffset);
      }
    } catch (error) {
      setLoadAllError(errorMessage(error));
    } finally {
      setLoadingAllLogs(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (logView === "logs" && initialLogs.length < initialTotalLogCount) {
      const timeoutId = window.setTimeout(() => {
        void loadAllLogs();
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [initialLogs.length, initialTotalLogCount, loadAllLogs, logView]);

  const visibleLogs = logs;
  const hasUnloadedLogs = logs.length < totalLogCount;

  return (
    <div className="grid min-w-0 items-start gap-3">
      <div className="grid min-w-0 gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <SegmentedControl
              value={logView}
              items={[
                {
                  value: "logs",
                  label: "Logs",
                  href: aiHref,
                },
                {
                  value: "raw-logs",
                  label: "Raw logs",
                  href: rawHref,
                },
              ]}
            />
            <Button
              href={textHref}
              icon={ScrollText}
              rel="noreferrer"
              size="sm"
              target="_blank"
              variant="ghost"
            >
              Plain-text logs
            </Button>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
            <StreamBadge status={streamStatus} />
            <span>
              Loaded {logs.length}/{totalLogCount} logs
            </span>
          </div>
        </div>

        {streamError ? (
          <div className="rounded-app-sm border border-app-warning-border bg-app-warning-bg px-2 py-1.5 text-[12px] text-app-warning">
            {streamError}
          </div>
        ) : null}

        {visibleLogs.length > 0 ? (
          <div className="grid min-w-0 gap-1">
            {visibleLogs.map((log, index) => {
              const message = agentLogMessage(log);
              const toolName =
                message?.type === "tool_call" ? message.tool : undefined;
              return (
                <LogRow
                  key={`${log.time}-${index}`}
                  log={log}
                  raw={logView === "raw-logs"}
                  toolName={toolName}
                />
              );
            })}
            {hasUnloadedLogs ? (
              <LoadAllLogsButton
                loadedCount={logs.length}
                loading={loadingAllLogs}
                onClick={() => void loadAllLogs()}
                totalCount={totalLogCount}
              />
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid place-items-center px-3 py-6 text-center text-[12px] text-app-text-muted">
              No logs yet
            </div>
            {hasUnloadedLogs ? (
              <LoadAllLogsButton
                loadedCount={logs.length}
                loading={loadingAllLogs}
                onClick={() => void loadAllLogs()}
                totalCount={totalLogCount}
              />
            ) : null}
          </div>
        )}
        {loadAllError ? (
          <div className="rounded-app-sm border border-app-warning-border bg-app-warning-bg px-2 py-1.5 text-[12px] text-app-warning">
            {loadAllError}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LoadAllLogsButton({
  loadedCount,
  loading,
  onClick,
  totalCount,
}: {
  loadedCount: number;
  loading: boolean;
  onClick: () => void;
  totalCount: number;
}) {
  return (
    <div className="grid justify-items-center gap-1.5 rounded-app border border-app-border-faint bg-app-surface-muted px-3 py-3 text-center">
      <Button
        icon={ScrollText}
        loading={loading}
        onClick={onClick}
        size="sm"
        variant="outline"
      >
        Load all logs
      </Button>
      <span className="text-[11px] text-app-text-muted">
        Loaded {loadedCount} of {totalCount}
      </span>
    </div>
  );
}

function StreamBadge({ status }: { status: StreamStatus }) {
  const isLive = status === "live";
  const Icon = isLive ? Wifi : WifiOff;
  const label = (
    {
      connecting: "Connecting",
      live: "Live",
      reconnecting: "Reconnecting",
      unavailable: "Unavailable",
    } as const
  )[status];

  return (
    <Badge
      tone={isLive ? "success" : status === "unavailable" ? "warning" : "info"}
    >
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function LogRow({
  anchorId,
  log,
  raw,
  toolName,
}: {
  anchorId?: string;
  log: LogEntry;
  raw: boolean;
  toolName?: string;
}) {
  const kind = raw ? logSourceKind(log) : logKind(log);
  const toolCategory = toolName ? toolCategoryForLog(log, toolName) : undefined;
  const text = raw ? JSON.stringify(log, null, 2) : formatLogText(log);
  const collapsible = Boolean(text && isCollapsibleLogText(text));
  const expandable = Boolean(text) && collapsible;
  const previewText = text && collapsible ? logPreviewText(text) : text;
  const contentTextClass = logContentTextClass(kind);

  if (!raw && isCompactLogKind(kind)) {
    return (
      <CompactEventLogRow
        anchorId={anchorId}
        kind={kind}
        log={log}
        text={text}
        toolCategory={toolCategory}
        toolName={toolName}
      />
    );
  }

  const header = (
    <div className="flex min-w-0 items-center gap-2 text-[12px]">
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-app-sm px-1.5 py-0.5 font-medium",
          logKindBadgeClass(kind),
        )}
      >
        {logKindIcon(kind)}
        {logKindLabel(kind)}
      </span>
      {toolCategory ? <ToolCategoryBadge category={toolCategory} /> : null}
      <span className={cn("min-w-0 flex-1 truncate", logHeaderTextClass(kind))}>
        {logTitle(log)}
      </span>
      <LocalDateTime
        className="shrink-0 whitespace-nowrap font-mono text-[11px] text-app-text-faint"
        relativeDay
        value={log.time}
      />
    </div>
  );

  return (
    <article
      id={anchorId}
      className={cn(
        "min-w-0 overflow-hidden rounded-app border border-app-border-faint bg-app-surface px-2.5 py-1.5",
        logKindRowClass(kind),
      )}
      style={anchorId ? { scrollMarginTop: "var(--header-h)" } : undefined}
    >
      {expandable ? (
        <details className="group">
          <summary className="cursor-pointer list-none outline-none [&::-webkit-details-marker]:hidden">
            <div className="flex items-center gap-1">
              <ChevronRight
                aria-hidden="true"
                className="size-3 shrink-0 text-app-text-faint transition-transform group-open:rotate-90"
              />
              <div className="min-w-0 flex-1">{header}</div>
            </div>
            <pre
              className={cn(
                "group-open:hidden mt-1.5 min-w-0 max-w-full whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed",
                contentTextClass,
              )}
            >
              {previewText}
            </pre>
          </summary>
          <pre
            className={cn(
              "mt-1.5 min-w-0 max-w-full whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed",
              contentTextClass,
            )}
          >
            {text}
          </pre>
        </details>
      ) : null}
      {!expandable ? header : null}
      {text && !expandable ? (
        <pre
          className={cn(
            "mt-1.5 min-w-0 max-w-full whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed",
            contentTextClass,
          )}
        >
          {previewText}
        </pre>
      ) : null}
    </article>
  );
}

function CompactEventLogRow({
  anchorId,
  kind,
  log,
  text,
  toolCategory,
  toolName,
}: {
  anchorId?: string;
  kind: CompactLogKind;
  log: LogEntry;
  text: string;
  toolCategory?: AgentToolCategory;
  toolName?: string;
}) {
  const label = compactEventLabel(log, kind, toolCategory);
  const title = compactEventTitle(log, kind, toolName);
  const expandable = Boolean(text && text !== title);
  const summary = (
    <>
      <span className="grid size-4 shrink-0 place-items-center text-app-text-muted">
        <CompactEventIcon kind={kind} />
      </span>
      <span className="shrink-0 font-medium text-app-text-secondary">
        {label}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-app-text-muted"
        title={title}
      >
        {title}
      </span>
    </>
  );

  return (
    <article
      id={anchorId}
      className="ml-5 min-w-0 border-l border-app-border-faint pl-2"
      style={anchorId ? { scrollMarginTop: "var(--header-h)" } : undefined}
    >
      {expandable ? (
        <details className="group">
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-app-sm py-1 text-[12px] leading-5 outline-none transition-colors hover:bg-app-surface-muted focus-visible:ring-2 focus-visible:ring-app-primary/25 [&::-webkit-details-marker]:hidden">
            {summary}
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 text-app-text-faint transition-transform group-open:rotate-90"
            />
          </summary>
          <pre className="my-1 ml-5 min-w-0 max-w-full whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-app-text-secondary">
            {text}
          </pre>
        </details>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 py-1 text-[12px] leading-5">
          {summary}
        </div>
      )}
    </article>
  );
}

function ToolCategoryBadge({ category }: { category: AgentToolCategory }) {
  const label = {
    execute: "Execute",
    mcp: "MCP",
    other: "Tool",
    read: "Read",
    search: "Search",
    skill: "Skill",
  }[category];
  const tone = {
    execute: "warning",
    mcp: "primary",
    other: "muted",
    read: "info",
    search: "info",
    skill: "success",
  } as const;
  return <Badge tone={tone[category]}>{label}</Badge>;
}

function toolCategoryForLog(
  log: LogEntry,
  toolName: string,
): AgentToolCategory {
  const kind = stringValue(recordValue(log.payload)?.kind)?.toLowerCase();
  if (
    kind === "execute" ||
    kind === "mcp" ||
    kind === "read" ||
    kind === "search" ||
    kind === "skill"
  ) {
    return kind;
  }
  return agentToolCategory(toolName);
}

function isCompactLogKind(kind: LogKind): kind is CompactLogKind {
  return kind === "program" || kind === "raw" || kind === "tool-call";
}

function compactEventLabel(
  log: LogEntry,
  kind: CompactLogKind,
  category?: AgentToolCategory,
) {
  if (kind === "program") {
    return stringValue(log.event)?.endsWith("_progress")
      ? "Running"
      : "Runtime";
  }
  if (kind === "raw") return "Raw event";

  return {
    execute: "Run",
    mcp: "Call",
    other: "Call",
    read: "Read",
    search: "Search",
    skill: "Load",
  }[category ?? "other"];
}

function compactEventTitle(
  log: LogEntry,
  kind: CompactLogKind,
  toolName?: string,
) {
  if (kind === "program") {
    return stringValue(log.event) ?? stringValue(log.msg) ?? "Runtime event";
  }
  if (kind === "raw") return logTitle(log);

  const message = agentLogMessage(log);
  if (message?.type === "tool_call") {
    const detail = toolInputDetail(message.input);
    return detail && !message.tool.includes(detail)
      ? `${message.tool} · ${detail}`
      : message.tool;
  }
  return toolName ?? logTitle(log);
}

function CompactEventIcon({ kind }: { kind: CompactLogKind }) {
  if (kind === "program" || kind === "raw") {
    return <TerminalSquare className="size-3.5" />;
  }
  if (kind === "tool-call") return <Wrench className="size-3.5" />;
}

function toolInputDetail(input: unknown) {
  const value = recordValue(input);
  if (!value) return undefined;

  for (const field of [
    "command",
    "path",
    "file_path",
    "query",
    "pattern",
  ] as const) {
    const detail = stringValue(value[field]);
    if (detail) return detail;
  }
  return undefined;
}

function logContentTextClass(kind: LogKind) {
  return kind === "assistant" || kind === "thinking"
    ? "text-app-text"
    : "text-app-text-secondary";
}

function logHeaderTextClass(kind: LogKind) {
  if (kind === "assistant" || kind === "thinking") return "text-app-text";
  return "text-app-text-muted";
}

function logKindBadgeClass(kind: LogKind) {
  return {
    assistant: "bg-app-info-bg text-app-info",
    program: "bg-app-surface-muted text-app-text-secondary",
    raw: "bg-app-surface-muted text-app-text-secondary",
    thinking: "bg-app-success-bg text-app-success",
    "tool-call": "bg-app-warning-bg text-app-warning",
    user: "bg-app-surface-muted text-app-text",
  }[kind];
}

function logKindRowClass(kind: LogKind) {
  return {
    assistant: "",
    program: "",
    raw: "",
    thinking: "border-app-success-border",
    "tool-call": "border-app-warning-border",
    user: "",
  }[kind];
}

function formatLogText(log: LogEntry) {
  const message = agentLogMessage(log);
  if (
    message?.type === "user" ||
    message?.type === "assistant" ||
    message?.type === "reasoning"
  ) {
    return message.content;
  }
  if (message?.type === "tool_call") {
    return message.input === null ? "" : JSON.stringify(message.input, null, 2);
  }
  if (log.payload !== undefined) return JSON.stringify(log.payload, null, 2);
  if (log.agent_message !== undefined)
    return JSON.stringify(log.agent_message, null, 2);
  if (typeof log.text === "string") return log.text;
  return summarizeLog(log) || JSON.stringify(log, null, 2);
}

function isCollapsibleLogText(text: string) {
  return text.split("\n").length > 4;
}

function logPreviewText(text: string) {
  return `${text.split("\n").slice(0, 3).join("\n")}\n...`;
}

function summarizeLog(log: LogEntry) {
  if (typeof log.msg === "string" && log.msg.includes("finding")) {
    const finding = recordValue(log.finding);
    return stringValue(finding?.title) ?? "";
  }
  return "";
}

function logSourceKind(log: LogEntry): LogKind {
  if (log.source === "user") return "user";
  return log.source === "ai" ? "assistant" : "program";
}

function logKind(log: LogEntry): LogKind {
  const message = agentLogMessage(log);
  if (message?.type === "reasoning") return "thinking";
  if (message?.type === "tool_call") return "tool-call";
  if (message?.type === "user") return "user";
  if (message?.type === "assistant") return "assistant";
  if (log.agent_message !== undefined) return "raw";
  return logSourceKind(log);
}

function logKindLabel(kind: LogKind) {
  return (
    {
      assistant: "AGENT",
      program: "Runtime",
      raw: "Raw event",
      thinking: "Thinking",
      "tool-call": "Tool call",
      user: "User",
    } as const
  )[kind];
}

function logKindIcon(kind: LogKind) {
  if (kind === "program" || kind === "raw") {
    return <TerminalSquare className="h-3 w-3" />;
  }
  if (kind === "user") return <UserRound className="h-3 w-3" />;
  if (kind === "thinking") return <Brain className="h-3 w-3" />;
  if (kind === "tool-call") return <Wrench className="h-3 w-3" />;
  return <Bot className="h-3 w-3" />;
}

function logTitle(log: LogEntry) {
  const message = agentLogMessage(log);
  if (message?.type === "tool_call") return message.tool;
  if (message?.type === "assistant" || message?.type === "reasoning") {
    return "assistant";
  }
  if (message?.type === "user") return "user";
  const rawAgentMessage = recordValue(log.agent_message);
  return (
    stringValue(log.event) ??
    stringValue(rawAgentMessage?.event) ??
    stringValue(rawAgentMessage?.type) ??
    stringValue(log.msg) ??
    "log"
  );
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
