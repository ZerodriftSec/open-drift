import type {
  UsageUpdate,
  ContentBlock,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AcpContextUsage, AgentMessage } from "@/audit/agent/types";
import type { JsonValue } from "@/audit/session/types";

export type AcpUpdateProjection = {
  message?: AgentMessage;
  outputChunk?: string;
  contextUsage?: AcpContextUsage;
  hasProgress: boolean;
  hasSideEffects: boolean;
};

export function acpUpdateToAgentMessage(
  update: SessionUpdate,
): AcpUpdateProjection {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = contentText(update.content);
      return {
        message: content ? { type: "assistant", content } : undefined,
        outputChunk: content,
        hasProgress: Boolean(content),
        hasSideEffects: false,
      };
    }
    case "agent_thought_chunk": {
      const content = contentText(update.content);
      return {
        message: content ? { type: "reasoning", content } : undefined,
        hasProgress: Boolean(content),
        hasSideEffects: false,
      };
    }
    case "tool_call":
      return {
        message: {
          type: "tool_call",
          callId: update.toolCallId,
          tool: update.title,
          input: toJsonValue(update.rawInput),
        },
        hasProgress: true,
        hasSideEffects: isSideEffectingToolKind(update.kind),
      };
    case "tool_call_update": {
      return {
        hasProgress: true,
        hasSideEffects: isSideEffectingToolKind(update.kind),
      };
    }
    case "usage_update":
      return {
        contextUsage: acpContextUsage(update),
        hasProgress: false,
        hasSideEffects: false,
      };
    case "user_message_chunk": {
      const content = contentText(update.content);
      return {
        message: content ? { type: "user", content } : undefined,
        hasProgress: false,
        hasSideEffects: false,
      };
    }
    case "plan":
    case "plan_update":
    case "plan_removed":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    default:
      return {
        hasProgress: true,
        hasSideEffects: false,
      };
  }
}

function acpContextUsage(update: UsageUpdate): AcpContextUsage {
  return {
    used: update.used,
    size: update.size,
    cost: update.cost,
    _meta: update._meta,
  };
}

const acpContextUsageTypeCheck =
  true satisfies UsageUpdate extends AcpContextUsage
    ? AcpContextUsage extends UsageUpdate
      ? true
      : false
    : false;
void acpContextUsageTypeCheck;

function contentText(content: ContentBlock) {
  if (!content || typeof content !== "object") return undefined;
  const record = content as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : undefined;
}

function isSideEffectingToolKind(kind: string | null | undefined) {
  return (
    kind === "execute" ||
    kind === "edit" ||
    kind === "delete" ||
    kind === "move"
  );
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
