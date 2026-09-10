import type { AgentMessage } from "@/audit/agent/types";

type AgentLogEntry = {
  agent_message?: unknown;
  event?: string;
  message?: unknown;
  msg?: string;
  payload?: unknown;
  sequence?: number;
  text?: string;
  time?: string;
  [key: string]: unknown;
};

export type AgentToolCategory =
  "execute" | "mcp" | "read" | "search" | "skill" | "other";

export function agentLogMessage(log: AgentLogEntry): AgentMessage | undefined {
  return isAgentMessage(log.message) ? log.message : undefined;
}

export function formatAgentLogDocument(
  logs: readonly AgentLogEntry[],
  {
    sessionId,
    source,
  }: {
    sessionId: string;
    source: "agent" | "program";
  },
) {
  const entries = logs
    .map(formatAgentLogEntry)
    .filter((entry) => entry.length > 0);

  return (
    [
      "ZERODRIFT SESSION LOG",
      `Session: ${sessionId}`,
      `Source: ${source}`,
      `Entries: ${entries.length}`,
      "",
      entries.join("\n\n"),
    ]
      .join("\n")
      .trimEnd() + "\n"
  );
}

function formatAgentLogEntry(log: AgentLogEntry) {
  const message = agentLogMessage(log);
  const body = message
    ? agentMessageText(message)
    : typeof log.text === "string" && log.text.length > 0
      ? log.text
      : typeof log.msg === "string" && log.msg.length > 0
        ? log.msg
        : log.agent_message !== undefined
          ? formattedValue(log.agent_message)
          : log.payload === undefined
            ? ""
            : formattedValue(log.payload);
  const label =
    log.event ?? rawAgentMessageLabel(log) ?? message?.type ?? "log";
  const metadata = [
    log.time ? `[${log.time}]` : undefined,
    Number.isInteger(log.sequence) ? `#${log.sequence}` : undefined,
    label,
  ]
    .filter(Boolean)
    .join(" ");

  return body ? `${metadata}\n${body}` : metadata;
}

function agentMessageText(message: AgentMessage) {
  switch (message.type) {
    case "user":
    case "assistant":
    case "reasoning":
      return message.content;
    case "tool_call":
      return `${message.tool}: ${formattedValue(message.input)}`;
  }
}

function formattedValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function rawAgentMessageLabel(log: AgentLogEntry) {
  const rawAgentMessage = recordValue(log.agent_message);
  return (
    stringValue(rawAgentMessage?.event) ?? stringValue(rawAgentMessage?.type)
  );
}

function isAgentMessage(value: unknown): value is AgentMessage {
  const record = recordValue(value);
  const type = stringValue(record?.type);
  if (
    (type === "user" || type === "assistant" || type === "reasoning") &&
    typeof record?.content === "string"
  ) {
    return true;
  }
  return (
    type === "tool_call" &&
    typeof record?.callId === "string" &&
    typeof record.tool === "string" &&
    "input" in record
  );
}

export function agentToolCategory(tool: string): AgentToolCategory {
  const normalized = tool.trim().toLowerCase();
  if (normalized.startsWith("skill view") || normalized.startsWith("skill_")) {
    return "skill";
  }
  if (normalized.startsWith("mcp_")) return "mcp";
  if (normalized === "read" || normalized.startsWith("read:")) return "read";
  if (
    normalized === "grep" ||
    normalized === "glob" ||
    normalized.startsWith("search")
  ) {
    return "search";
  }
  if (
    normalized === "bash" ||
    normalized.startsWith("terminal:") ||
    normalized.startsWith("python:")
  ) {
    return "execute";
  }
  return "other";
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
