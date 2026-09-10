import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

const GOAL_START_TIMEOUT_MS = 30_000;

export type CodexAppServerNotification = {
  method: string;
  params: unknown;
};

export type CodexAppServerThread = { id: string };

export type CodexAppServerTurn = {
  agentMessage?: string;
  error?: string;
  id: string;
  status: "completed" | "failed" | "interrupted";
};

export type CodexAppServerThreadOptions = {
  config?: Record<string, unknown>;
  cwd: string;
  model: string;
  modelProvider: "openai";
  sandbox?: "danger-full-access" | "read-only";
};

export type CodexAppServerClientOptions = {
  command?: string;
  configOverrides?: readonly string[];
  cwd: string;
  onNotification?(notification: CodexAppServerNotification): void;
};

type RequestId = number | string;

type Deferred<T> = {
  promise: Promise<T>;
  reject(error: Error): void;
  resolve(value: T): void;
};

type GoalStatus =
  | "active"
  | "blocked"
  | "budgetLimited"
  | "complete"
  | "paused"
  | "usageLimited";

type GoalRun = Deferred<CodexAppServerTurn> & {
  cleared: boolean;
  currentTurnId?: string;
  failedTurn?: CodexAppServerTurn;
  interrupted: boolean;
  lastPhysicalTurnId?: string;
  lastTurn?: CodexAppServerTurn;
  logicalTurnId?: string;
  onStarted?(turnId: string): void | Promise<void>;
  routingActive: boolean;
  settled: boolean;
  started?: Promise<void>;
  startTimer?: ReturnType<typeof setTimeout>;
  status?: GoalStatus;
  threadId: string;
};

/** Minimal process owner and JSONL RPC adapter for `codex app-server`. */
export class CodexAppServerClient {
  private readonly agentMessages = new Map<string, string>();
  private readonly completedTurns = new Map<string, CodexAppServerTurn>();
  private readonly goalsByThread = new Map<string, GoalRun>();
  private readonly goalsByTurn = new Map<string, GoalRun>();
  private readonly lineReader: Interface;
  private readonly pending = new Map<RequestId, Deferred<unknown>>();
  private readonly turnWaiters = new Map<
    string,
    Deferred<CodexAppServerTurn>
  >();
  private closePromise?: Promise<void>;
  private closed = false;
  private failure?: Error;
  private nextRequestId = 1;
  private stderr = "";

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification?: (
      notification: CodexAppServerNotification,
    ) => void,
  ) {
    this.lineReader = createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    this.lineReader.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      if (this.closed) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      this.fail(new Error(`Codex app-server exited with ${detail}.`));
    });
  }

  static async start({
    command,
    configOverrides = [],
    cwd,
    onNotification,
  }: CodexAppServerClientOptions): Promise<CodexAppServerClient> {
    const executable =
      command?.trim() || process.env.CODEX_CLI_PATH?.trim() || "codex";
    const environment = { ...process.env };
    delete environment.CODEX_THREAD_ID;
    const client = new CodexAppServerClient(
      spawnAppServer(executable, configOverrides, cwd, environment),
      onNotification,
    );
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "zerodrift-agent",
          title: "Zerodrift Agent",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  startThread(
    options: CodexAppServerThreadOptions,
  ): Promise<CodexAppServerThread> {
    return this.threadRequest("thread/start", {
      ...options,
      // Goal mode requires a persisted thread.
      ephemeral: false,
    });
  }

  resumeThread(
    threadId: string,
    options: CodexAppServerThreadOptions,
  ): Promise<CodexAppServerThread> {
    return this.threadRequest("thread/resume", { threadId, ...options });
  }

  forkThread(
    threadId: string,
    lastTurnId: string | undefined,
    options: CodexAppServerThreadOptions,
  ): Promise<CodexAppServerThread> {
    return this.threadRequest("thread/fork", {
      threadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...options,
    });
  }

  async runTurn({
    effort,
    onStarted,
    outputSchema,
    prompt,
    threadId,
  }: {
    effort: string;
    onStarted?(turnId: string): void | Promise<void>;
    outputSchema?: Record<string, unknown>;
    prompt: string;
    threadId: string;
  }): Promise<CodexAppServerTurn> {
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      effort,
      ...(outputSchema ? { outputSchema } : {}),
    });
    const turnId = turnIdFromResponse(result);
    const completed = this.waitForTurn(turnId);
    await onStarted?.(turnId);
    return completed;
  }

  async runGoal({
    onStarted,
    prompt,
    threadId,
  }: {
    onStarted?(turnId: string): void | Promise<void>;
    prompt: string;
    threadId: string;
  }): Promise<CodexAppServerTurn> {
    if (this.goalsByThread.has(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active Goal.`);
    }
    const goal: GoalRun = {
      ...deferred<CodexAppServerTurn>(),
      cleared: false,
      interrupted: false,
      onStarted,
      routingActive: false,
      settled: false,
      threadId,
    };
    this.goalsByThread.set(threadId, goal);

    try {
      await this.request("thread/goal/clear", { threadId });
      goal.routingActive = true;
      const result = await this.request("thread/goal/set", {
        objective: prompt,
        status: "active",
        threadId,
      });
      if (!goal.settled) {
        goal.status = goalStatusFromResponse(result) ?? goal.status;
        if (!goal.logicalTurnId) this.armGoalStartTimeout(goal);
      }
    } catch (error) {
      this.rejectGoal(goal, asError(error));
    }
    return goal.promise;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const goal = this.goalsByTurn.get(turnId);
    if (!goal || goal.threadId !== threadId) {
      await this.request("turn/interrupt", { threadId, turnId });
      return;
    }

    goal.interrupted = true;
    try {
      const result = await this.request("thread/goal/set", {
        status: "paused",
        threadId,
      });
      if (!goal.settled) {
        goal.status = goalStatusFromResponse(result) ?? "paused";
        this.emitMaybe(this.maybeCompleteGoal(goal));
      }
    } catch (error) {
      goal.interrupted = false;
      throw error;
    }
    if (goal.settled) return;

    const physicalTurnId =
      goal.currentTurnId ?? goal.lastPhysicalTurnId ?? goal.logicalTurnId;
    if (!physicalTurnId) return;
    try {
      await this.request("turn/interrupt", {
        threadId,
        turnId: physicalTurnId,
      });
    } catch (error) {
      const nextTurnId = goal.currentTurnId;
      if (nextTurnId && nextTurnId !== physicalTurnId) {
        await this.request("turn/interrupt", { threadId, turnId: nextTurnId });
      } else if (!goal.settled) {
        throw error;
      }
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.shutdown();
    return this.closePromise;
  }

  private async shutdown() {
    if (!this.closed) {
      this.closed = true;
      this.failure = new Error("Codex app-server connection closed.");
      this.rejectAll(this.failure);
    }
    this.lineReader.close();
    if (this.child.stdin.writable && !this.child.stdin.writableEnded) {
      this.child.stdin.end();
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await waitForExit(this.child);
    }
  }

  private async threadRequest(
    method: "thread/start" | "thread/resume" | "thread/fork",
    params: Record<string, unknown>,
  ): Promise<CodexAppServerThread> {
    const thread = record(record(await this.request(method, params))?.thread);
    const id = string(thread?.id);
    if (!id) throw new Error(`${method} did not return a thread ID.`);
    return { id };
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        this.failure ?? new Error("Codex app-server connection is closed."),
      );
    }
    const id = this.nextRequestId++;
    const request = deferred<unknown>();
    this.pending.set(id, request);
    this.write({ id, method, params });
    return request.promise;
  }

  private notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  private write(message: unknown) {
    if (this.closed) return;
    if (!this.child.stdin.writable) {
      this.fail(new Error("Codex app-server stdin is not writable."));
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.fail(error);
      });
    } catch (error) {
      this.fail(asError(error));
    }
  }

  private handleLine(line: string) {
    let payload: Record<string, unknown> | undefined;
    try {
      payload = record(JSON.parse(line));
    } catch {
      this.fail(new Error(`Codex app-server sent invalid JSON: ${line}`));
      return;
    }
    if (!payload) return;

    if (
      isRequestId(payload.id) &&
      ("result" in payload || "error" in payload)
    ) {
      const request = this.pending.get(payload.id);
      if (!request) return;
      this.pending.delete(payload.id);
      if ("error" in payload) request.reject(rpcError(payload.error));
      else request.resolve(payload.result);
      return;
    }
    if (typeof payload.method !== "string") return;
    if (isRequestId(payload.id)) {
      this.write({
        id: payload.id,
        error: {
          code: -32601,
          message: `Unsupported app-server request: ${payload.method}`,
        },
      });
      return;
    }
    this.handleNotification({
      method: payload.method,
      params: payload.params,
    });
  }

  private handleNotification(notification: CodexAppServerNotification) {
    if (notification.method === "item/completed") {
      const params = record(notification.params);
      const item = record(params?.item);
      const turnId = string(params?.turnId);
      const text =
        item?.type === "agentMessage" ? string(item.text) : undefined;
      if (turnId && text) this.agentMessages.set(turnId, text);
    }

    let turn =
      notification.method === "turn/completed"
        ? completedTurn(notification.params)
        : undefined;
    if (turn) {
      const agentMessage = turn.agentMessage ?? this.agentMessages.get(turn.id);
      this.agentMessages.delete(turn.id);
      turn = { ...turn, ...(agentMessage ? { agentMessage } : {}) };
    }

    const routed = this.routeGoalNotification(notification, turn);
    if (routed !== undefined) {
      this.emitMaybe(routed);
      return;
    }
    if (turn) this.completeTurn(turn);
    this.emit(notification);
  }

  /** `undefined` means non-Goal; `null` means handled and intentionally hidden. */
  private routeGoalNotification(
    notification: CodexAppServerNotification,
    completed: CodexAppServerTurn | undefined,
  ): CodexAppServerNotification | null | undefined {
    const params = record(notification.params);
    const threadId = string(params?.threadId);
    const goal = threadId ? this.goalsByThread.get(threadId) : undefined;
    if (!goal) return undefined;

    if (notification.method === "thread/goal/updated") {
      const status = goalStatus(record(params?.goal)?.status);
      if (status) {
        goal.status = status;
        if (status === "active") goal.cleared = false;
      }
      return this.maybeCompleteGoal(goal);
    }
    if (notification.method === "thread/goal/cleared") {
      goal.cleared = true;
      return this.maybeCompleteGoal(goal);
    }

    const physicalTurnId = notificationTurnId(notification);
    if (!physicalTurnId || !goal.routingActive) return undefined;
    goal.lastPhysicalTurnId = physicalTurnId;

    if (notification.method === "turn/started") {
      const firstTurn = !goal.logicalTurnId;
      goal.currentTurnId = physicalTurnId;
      if (firstTurn) this.bindGoalTurn(goal, physicalTurnId);
      return firstTurn && goal.logicalTurnId
        ? logicalNotification(notification, goal.logicalTurnId)
        : null;
    }
    if (notification.method !== "turn/completed") {
      return goal.logicalTurnId
        ? logicalNotification(notification, goal.logicalTurnId)
        : null;
    }
    if (!completed) {
      this.rejectGoal(
        goal,
        new Error("Codex app-server sent an invalid Goal turn completion."),
      );
      return null;
    }

    goal.lastTurn = completed;
    if (completed.status === "failed") goal.failedTurn = completed;
    if (goal.currentTurnId === physicalTurnId) goal.currentTurnId = undefined;
    if (completed.status === "interrupted") {
      goal.interrupted = true;
      return this.completeGoal(goal, completed);
    }
    if (goal.status === undefined && !goal.cleared) {
      this.rejectGoal(
        goal,
        new Error("Codex runtime did not activate Goal mode for this turn."),
      );
      return null;
    }
    return this.maybeCompleteGoal(goal);
  }

  private bindGoalTurn(goal: GoalRun, turnId: string) {
    goal.logicalTurnId = turnId;
    this.goalsByTurn.set(turnId, goal);
    if (goal.startTimer) clearTimeout(goal.startTimer);
    goal.startTimer = undefined;
    goal.started = (async () => {
      await goal.onStarted?.(turnId);
    })();
    void goal.started.catch((error) => this.rejectGoal(goal, asError(error)));
  }

  private armGoalStartTimeout(goal: GoalRun) {
    goal.startTimer = setTimeout(() => {
      this.rejectGoal(
        goal,
        new Error("Timed out waiting 30 seconds for Codex Goal to start."),
      );
      void this.request("thread/goal/set", {
        status: "paused",
        threadId: goal.threadId,
      }).catch(() => undefined);
    }, GOAL_START_TIMEOUT_MS);
  }

  private maybeCompleteGoal(goal: GoalRun): CodexAppServerNotification | null {
    if (
      goal.settled ||
      !goal.logicalTurnId ||
      goal.currentTurnId ||
      !goal.lastTurn ||
      (!goal.cleared && !terminalGoalStatus(goal.status))
    ) {
      return null;
    }
    return this.completeGoal(goal, goal.failedTurn ?? goal.lastTurn);
  }

  private completeGoal(
    goal: GoalRun,
    physicalTurn: CodexAppServerTurn,
  ): CodexAppServerNotification | null {
    if (goal.settled || !goal.logicalTurnId) return null;
    const turn: CodexAppServerTurn = {
      ...physicalTurn,
      id: goal.logicalTurnId,
      ...(goal.interrupted ? { status: "interrupted" as const } : {}),
    };
    goal.settled = true;
    this.removeGoal(goal);
    void (goal.started ?? Promise.resolve()).then(
      () => goal.resolve(turn),
      (error) => goal.reject(asError(error)),
    );
    return completionNotification(goal.threadId, turn);
  }

  private rejectGoal(goal: GoalRun, error: Error) {
    if (goal.settled) return;
    goal.settled = true;
    this.removeGoal(goal);
    goal.reject(error);
  }

  private removeGoal(goal: GoalRun) {
    if (goal.startTimer) clearTimeout(goal.startTimer);
    if (this.goalsByThread.get(goal.threadId) === goal) {
      this.goalsByThread.delete(goal.threadId);
    }
    if (
      goal.logicalTurnId &&
      this.goalsByTurn.get(goal.logicalTurnId) === goal
    ) {
      this.goalsByTurn.delete(goal.logicalTurnId);
    }
  }

  private waitForTurn(turnId: string) {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    const waiter = deferred<CodexAppServerTurn>();
    this.turnWaiters.set(turnId, waiter);
    return waiter.promise;
  }

  private completeTurn(turn: CodexAppServerTurn) {
    const waiter = this.turnWaiters.get(turn.id);
    if (waiter) {
      this.turnWaiters.delete(turn.id);
      waiter.resolve(turn);
    } else {
      this.completedTurns.set(turn.id, turn);
    }
  }

  private emitMaybe(notification: CodexAppServerNotification | null) {
    if (notification) this.emit(notification);
  }

  private emit(notification: CodexAppServerNotification) {
    try {
      this.onNotification?.(notification);
    } catch (error) {
      this.fail(asError(error));
    }
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    const stderr = this.stderr.trim();
    this.failure = stderr
      ? new Error(`${error.message} ${stderr}`, { cause: error })
      : error;
    this.lineReader.close();
    this.rejectAll(this.failure);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
    for (const goal of [...this.goalsByThread.values()]) {
      this.rejectGoal(goal, error);
    }
    this.completedTurns.clear();
    this.agentMessages.clear();
  }
}

function spawnAppServer(
  executable: string,
  configOverrides: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  return Reflect.apply(spawn, undefined, [
    executable,
    [
      "app-server",
      "--listen",
      "stdio://",
      ...configOverrides.flatMap((override) => ["--config", override]),
    ],
    { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] },
  ]) as ChildProcessWithoutNullStreams;
}

function turnIdFromResponse(result: unknown) {
  const id = string(record(record(result)?.turn)?.id);
  if (!id) throw new Error("turn/start did not return a turn ID.");
  return id;
}

function completedTurn(params: unknown): CodexAppServerTurn | undefined {
  const turn = record(record(params)?.turn);
  if (!turn) return undefined;
  const id = string(turn.id);
  const status = string(turn.status);
  if (
    !id ||
    (status !== "completed" && status !== "failed" && status !== "interrupted")
  ) {
    return undefined;
  }
  const item = Array.isArray(turn.items)
    ? [...turn.items]
        .reverse()
        .map(record)
        .find((candidate) => candidate?.type === "agentMessage")
    : undefined;
  const error = string(record(turn.error)?.message);
  const agentMessage = string(item?.text);
  return {
    id,
    status,
    ...(error ? { error } : {}),
    ...(agentMessage ? { agentMessage } : {}),
  };
}

function notificationTurnId(notification: CodexAppServerNotification) {
  const params = record(notification.params);
  return string(params?.turnId) ?? string(record(params?.turn)?.id);
}

function logicalNotification(
  notification: CodexAppServerNotification,
  turnId: string,
): CodexAppServerNotification {
  const params = record(notification.params);
  if (!params) return notification;
  const turn = record(params.turn);
  return {
    method: notification.method,
    params: {
      ...params,
      ...(typeof params.turnId === "string" ? { turnId } : {}),
      ...(turn && typeof turn.id === "string"
        ? { turn: { ...turn, id: turnId } }
        : {}),
    },
  };
}

function completionNotification(
  threadId: string,
  turn: CodexAppServerTurn,
): CodexAppServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turn.id,
        items: [],
        status: turn.status,
        ...(turn.error ? { error: { message: turn.error } } : {}),
      },
    },
  };
}

function goalStatusFromResponse(result: unknown) {
  return goalStatus(record(record(result)?.goal)?.status);
}

function goalStatus(value: unknown): GoalStatus | undefined {
  return value === "active" ||
    value === "blocked" ||
    value === "budgetLimited" ||
    value === "complete" ||
    value === "paused" ||
    value === "usageLimited"
    ? value
    : undefined;
}

function terminalGoalStatus(status: GoalStatus | undefined) {
  return status !== undefined && status !== "active";
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function rpcError(value: unknown) {
  const error = record(value);
  return new Error(string(error?.message) ?? "Unknown JSON-RPC error.");
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "number" || typeof value === "string";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

async function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}
