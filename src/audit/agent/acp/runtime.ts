import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentCapabilities,
  type Client,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { acpUpdateToAgentMessage } from "./messages";

export type AcpRuntimeDefinition = {
  command: string;
  args: readonly string[];
  env?: Record<string, string | undefined>;
  inheritEnvironment?: boolean;
  terminalErrorAdapter?: (message: string) => string | undefined;
};

export type AcpRuntimeSessionInput = {
  cwd: string;
  launch: AcpRuntimeDefinition;
  mcpServers?: readonly McpServer[];
  onRawEvent(event: string, payload: unknown): void;
  onTextChunk?(
    event: "agent_message_chunk" | "agent_thought_chunk",
    payload: unknown,
  ): void;
};

export type AcpRuntimeTurnInput = {
  prompt: string;
  signal?: AbortSignal;
};

export type AcpRuntimeInput = AcpRuntimeSessionInput & AcpRuntimeTurnInput;

export type AcpRuntimeResult = {
  status: "completed" | "failed" | "interrupted";
  durationMs: number;
  output?: string;
  hasProgress: boolean;
  hasSideEffects: boolean;
  error?: { message: string; retryable: boolean };
};

export type AcpRuntimeSession = {
  readonly sessionId: string;
  cancel(): Promise<void>;
  runTurn(input: AcpRuntimeTurnInput): Promise<AcpRuntimeResult>;
  close(): Promise<void>;
};

type AcpSessionConnection = {
  capabilities: AgentCapabilities;
  connection: ClientSideConnection;
  sessionInput: {
    cwd: string;
    mcpServers: McpServer[];
  };
};

type OpenAcpSession = (input: AcpSessionConnection) => Promise<string>;

type ActiveTurn = {
  cancelRequested: boolean;
  signal?: AbortSignal;
  output: string;
  hasProgress: boolean;
  hasSideEffects: boolean;
  providerFailure?: string;
  bufferedChunk?: {
    event: "agent_message_chunk" | "agent_thought_chunk";
    text: string;
  };
};

export async function createAcpRuntimeSession(
  input: AcpRuntimeSessionInput,
): Promise<AcpRuntimeSession> {
  return openAcpRuntimeSession(input, async ({ connection, sessionInput }) => {
    const response = await connection.newSession(sessionInput);
    input.onRawEvent("new_session_response", response);
    return response.sessionId;
  });
}

export async function resumeAcpRuntimeSession(
  threadId: string,
  input: AcpRuntimeSessionInput,
): Promise<AcpRuntimeSession> {
  return openAcpRuntimeSession(
    input,
    async ({ capabilities, connection, sessionInput }) => {
      if (capabilities.sessionCapabilities?.resume != null) {
        const response = await connection.resumeSession({
          ...sessionInput,
          sessionId: threadId,
        });
        input.onRawEvent("resume_session_response", response);
        return threadId;
      }
      if (capabilities.loadSession) {
        const response = await connection.loadSession({
          ...sessionInput,
          sessionId: threadId,
        });
        input.onRawEvent("load_session_response", response);
        return threadId;
      }
      throw new Error("ACP Agent does not support resuming threads.");
    },
  );
}

export async function forkAcpRuntimeSession(
  threadId: string,
  input: AcpRuntimeSessionInput,
): Promise<AcpRuntimeSession> {
  return openAcpRuntimeSession(
    input,
    async ({ capabilities, connection, sessionInput }) => {
      if (capabilities.sessionCapabilities?.fork == null) {
        throw new Error("ACP Agent does not support forking threads.");
      }
      const response = await connection.unstable_forkSession({
        ...sessionInput,
        sessionId: threadId,
      });
      input.onRawEvent("fork_session_response", response);
      return response.sessionId;
    },
  );
}

async function openAcpRuntimeSession(
  input: AcpRuntimeSessionInput,
  openSession: OpenAcpSession,
): Promise<AcpRuntimeSession> {
  const child = spawn(input.launch.command, [...input.launch.args], {
    cwd: input.cwd,
    env: createAcpProcessEnvironment(
      input.launch.env,
      input.launch.inheritEnvironment,
    ),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let connection: ClientSideConnection | undefined;
  let providerSessionId = "";
  let activeTurn: ActiveTurn | undefined;
  let closed = false;

  child.on("spawn", () => {
    if (closed) return;
    input.onRawEvent("process_spawn", {
      args: [...input.launch.args],
      command: input.launch.command,
      cwd: input.cwd,
    });
  });
  child.on("error", (error) => {
    stderr = `${stderr}${error.message}`.slice(-16_384);
    if (closed) return;
    input.onRawEvent("process_error", {
      message: error.message,
      name: error.name,
    });
  });
  child.on("exit", (code, signal) => {
    if (closed) return;
    input.onRawEvent("process_exit", { code, signal });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
    if (activeTurn) {
      activeTurn.providerFailure ??= terminalProviderFailure(
        chunk,
        input.launch.terminalErrorAdapter,
      );
    }
    if (closed) return;
    input.onRawEvent("process_stderr", { chunk });
  });

  const client: Client = {
    requestPermission: (params) => {
      input.onRawEvent("request_permission", params);
      const response = approvePermission(params, activeTurn?.signal);
      input.onRawEvent("request_permission_response", response);
      return response;
    },
    sessionUpdate: (notification) => {
      if (!activeTurn || notification.sessionId !== providerSessionId) return;
      projectUpdate(activeTurn, notification.update);
    },
  };

  function projectUpdate(turn: ActiveTurn, update: SessionUpdate) {
    const projected = acpUpdateToAgentMessage(update);
    const text =
      projected.message?.type === "assistant" ||
      projected.message?.type === "reasoning"
        ? projected.message.content
        : undefined;
    if (text) {
      turn.providerFailure ??= terminalProviderFailure(
        text,
        input.launch.terminalErrorAdapter,
      );
    }
    if (
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") &&
      text
    ) {
      if (turn.bufferedChunk?.event !== update.sessionUpdate) {
        flushChunk(turn);
        turn.bufferedChunk = { event: update.sessionUpdate, text };
      } else {
        turn.bufferedChunk.text += text;
      }
      input.onTextChunk?.(update.sessionUpdate, update);
      if (projected.outputChunk) turn.output += projected.outputChunk;
      turn.hasProgress ||= projected.hasProgress;
      turn.hasSideEffects ||= projected.hasSideEffects;
      return;
    }
    flushChunk(turn);
    input.onRawEvent(update.sessionUpdate, update);
    if (projected.outputChunk) turn.output += projected.outputChunk;
    turn.hasProgress ||= projected.hasProgress;
    turn.hasSideEffects ||= projected.hasSideEffects;
  }

  function flushChunk(turn: ActiveTurn) {
    if (!turn.bufferedChunk) return;
    input.onRawEvent(turn.bufferedChunk.event, {
      sessionUpdate: turn.bufferedChunk.event,
      content: { type: "text", text: turn.bufferedChunk.text },
    });
    turn.bufferedChunk = undefined;
  }

  async function cancel() {
    if (!connection || !providerSessionId || !activeTurn) return;
    activeTurn.cancelRequested = true;
    await connection.cancel({ sessionId: providerSessionId });
  }

  async function close() {
    if (closed) return;
    closed = true;
    await cancel().catch(() => undefined);
    child.kill("SIGTERM");
    await waitForExit(child, 2_000);
  }

  try {
    if (!child.stdin || !child.stdout) {
      throw new Error("ACP process stdio is unavailable");
    }
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    connection = new ClientSideConnection(() => client, stream);
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "zerodrift-agent", version: "1.0.0" },
    });
    input.onRawEvent("initialize_response", initialized);
    providerSessionId = await openSession({
      capabilities: initialized.agentCapabilities ?? {},
      connection,
      sessionInput: {
        cwd: input.cwd,
        mcpServers: [...(input.mcpServers ?? [])],
      },
    });
  } catch (error) {
    await close();
    throw new Error(errorMessage(error, stderr));
  }

  return {
    sessionId: providerSessionId,
    cancel,
    runTurn: async ({ prompt, signal }) => {
      const startedAt = Date.now();
      if (closed) throw new Error("ACP session is closed");
      if (activeTurn) throw new Error("ACP session already has an active turn");
      const turn: ActiveTurn = {
        cancelRequested: false,
        signal,
        output: "",
        hasProgress: false,
        hasSideEffects: false,
      };
      activeTurn = turn;
      const onAbort = () => {
        void cancel().catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        if (signal?.aborted) onAbort();
        const response = await connection!.prompt({
          sessionId: providerSessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        flushChunk(turn);
        input.onRawEvent("prompt_response", response);
        const interrupted =
          response.stopReason === "cancelled" ||
          signal?.aborted ||
          turn.cancelRequested;
        const failure =
          turn.providerFailure ??
          (response.stopReason === "refusal"
            ? `ACP agent stopped with ${response.stopReason}`
            : undefined);
        return {
          status: interrupted
            ? "interrupted"
            : failure
              ? "failed"
              : "completed",
          durationMs: Date.now() - startedAt,
          output: turn.output || undefined,
          hasProgress: turn.hasProgress,
          hasSideEffects: turn.hasSideEffects,
          error: failure
            ? { message: failure, retryable: isRetryableError(failure) }
            : undefined,
        };
      } catch (error) {
        const interrupted =
          signal?.aborted || turn.cancelRequested || isAbortError(error);
        const message = errorMessage(error, stderr);
        return {
          status: interrupted ? "interrupted" : "failed",
          durationMs: Date.now() - startedAt,
          output: turn.output || undefined,
          hasProgress: turn.hasProgress,
          hasSideEffects: turn.hasSideEffects,
          error: interrupted
            ? undefined
            : { message, retryable: isRetryableError(message) },
        };
      } finally {
        flushChunk(turn);
        signal?.removeEventListener("abort", onAbort);
        activeTurn = undefined;
      }
    },
    close,
  };
}

export async function runAcpPrompt(
  input: AcpRuntimeInput,
): Promise<AcpRuntimeResult> {
  const session = await createAcpRuntimeSession(input);
  try {
    return await session.runTurn({
      prompt: input.prompt,
      signal: input.signal,
    });
  } finally {
    await session.close();
  }
}

function approvePermission(
  params: RequestPermissionRequest,
  signal?: AbortSignal,
): RequestPermissionResponse {
  if (signal?.aborted) return { outcome: { outcome: "cancelled" } };
  const option =
    params.options.find(({ kind }) => kind === "allow_always") ??
    params.options.find(({ kind }) => kind === "allow_once");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function createAcpProcessEnvironment(
  extra?: Record<string, string | undefined>,
  inheritEnvironment = true,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = inheritEnvironment
    ? { ...process.env }
    : runtimeBaseEnvironment();
  Object.assign(env, extra);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  return env;
}

function runtimeBaseEnvironment(): NodeJS.ProcessEnv {
  const allowedKeys = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_PROXY",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ];
  return Object.fromEntries(
    allowedKeys.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  ) as NodeJS.ProcessEnv;
}

export function terminalProviderFailure(
  message: string,
  adapter?: (message: string) => string | undefined,
) {
  const adapted = adapter?.(message);
  if (adapted) return adapted;

  const match = message.match(
    /API call failed after \d+ retries[.:]?\s*([^\n]*)/i,
  );
  return match
    ? match[0].replace(/\s+/g, " ").trim().slice(0, 2_000)
    : undefined;
}

function errorMessage(error: unknown, stderr: string) {
  const primary = error instanceof Error ? error.message : String(error);
  const detail = stderr.trim();
  return detail && !primary.includes(detail)
    ? `${primary}: ${detail}`
    : primary;
}

function isRetryableError(message: string) {
  return /(?:http\s*)?429|quota|rate.?limit|usage limit|resource exhausted|timeout|ECONNRESET/i.test(
    message,
  );
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /abort/i.test(error.message))
  );
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}
