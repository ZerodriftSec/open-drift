import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import {
  CodexAgent,
  CodexModel,
  CodexReasoningEffort,
  codexAgentDefinitions,
} from "@/audit/agent/codex";
import { CodexAppServerClient } from "@/audit/agent/codex/app-server";
import { registerAgentDefinitions } from "@/audit/agent/registry";
import { AgentProvider } from "@/audit/agent/types";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("registers GPT-5.6 Sol and Luna with max reasoning", () => {
  const definitions = registerAgentDefinitions(codexAgentDefinitions);

  expect(
    definitions
      .filter((definition) => definition.model.startsWith("gpt-5.6-"))
      .map((definition) => definition.id),
  ).toEqual(["codex-gpt-5.6-sol-max", "codex-gpt-5.6-luna-max"]);
});

test("uses the local codex command from PATH by default", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-path-"));
  const executable = path.join(directory, "codex");
  const requestLog = path.join(directory, "requests.jsonl");
  await writeFile(executable, fakeCodexAppServer, "utf8");
  await chmod(executable, 0o755);
  vi.stubEnv("CODEX_CLI_PATH", "");
  vi.stubEnv("FAKE_CODEX_REQUEST_LOG", requestLog);
  vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);

  try {
    const client = await CodexAppServerClient.start({ cwd: directory });
    await client.close();

    const requests = await readRequests(requestLog);
    expect(requests[0]).toEqual({
      argv: ["app-server", "--listen", "stdio://"],
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("runs a native Goal as one logical turn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-app-server-"));
  const executable = path.join(directory, "fake-codex.mjs");
  const requestLog = path.join(directory, "requests.jsonl");
  await writeFile(executable, fakeCodexAppServer, "utf8");
  await chmod(executable, 0o755);
  vi.stubEnv("CODEX_CLI_PATH", executable);
  vi.stubEnv("FAKE_CODEX_REQUEST_LOG", requestLog);

  try {
    const [definition] = registerAgentDefinitions([codexAgentDefinitions[0]]);
    if (!definition || definition.provider !== AgentProvider.CODEX) {
      throw new Error("Expected a Codex agent definition.");
    }
    const events: unknown[] = [];
    const agent = new CodexAgent(definition);

    await expect(
      agent.newThread(
        ["Review the migration."],
        {
          cwd: directory,
          goal: true,
          onThreadEvent: (event) => {
            events.push(event);
          },
        },
        pino({ enabled: false }),
      ),
    ).resolves.toEqual({ threadId: "fake-thread", turns: [{}] });

    expect(events).toEqual([
      { type: "thread", threadId: "fake-thread" },
      {
        type: "turn",
        threadId: "fake-thread",
        turnId: "fake-goal-turn-1",
      },
    ]);
    const requests = await readRequests(requestLog);
    expect(
      requests.filter((request) => request.method === "thread/goal/clear"),
    ).toHaveLength(1);
    expect(
      requests.find((request) => request.method === "thread/goal/set"),
    ).toMatchObject({
      params: {
        objective: "Review the migration.",
        status: "active",
        threadId: "fake-thread",
      },
    });
    expect(requests.some((request) => request.method === "turn/start")).toBe(
      false,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("pins OpenAI provider and handles array outputSchema", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-app-server-"));
  const executable = path.join(directory, "fake-codex.mjs");
  const requestLog = path.join(directory, "requests.jsonl");
  await writeFile(executable, fakeCodexAppServer, "utf8");
  await chmod(executable, 0o755);
  vi.stubEnv("CODEX_CLI_PATH", executable);
  vi.stubEnv("FAKE_CODEX_REQUEST_LOG", requestLog);

  try {
    const registration = codexAgentDefinitions.find(
      (item) =>
        item.model === CodexModel.GPT_5_6_SOL &&
        item.reasoningEffort === CodexReasoningEffort.MAX,
    );
    if (!registration) throw new Error("Expected a GPT-5.6 Sol max agent.");
    const [definition] = registerAgentDefinitions([registration]);
    if (!definition || definition.provider !== AgentProvider.CODEX) {
      throw new Error("Expected a Codex agent definition.");
    }
    const agent = new CodexAgent(definition);
    const outputSchema = {
      items: { type: "object" },
      type: "array",
    };

    await expect(
      agent.newThread(
        ["Return the findings."],
        {
          cwd: directory,
          mcpServers: [],
          outputSchema,
          sandbox: "read-only",
          webSearch: "disabled",
        },
        pino({ enabled: false }),
      ),
    ).resolves.toMatchObject({
      threadId: "fake-thread",
      turns: [{ structuredOutput: [{ finding_id: 7 }] }],
    });

    const requests = await readRequests(requestLog);
    const argv = requests[0]?.argv;
    expect(Array.isArray(argv) ? argv.slice(0, 3) : argv).toEqual([
      "app-server",
      "--listen",
      "stdio://",
    ]);
    expect(
      requests.find((request) => request.method === "turn/start"),
    ).toMatchObject({
      params: {
        effort: "max",
        outputSchema: {
          additionalProperties: false,
          properties: { items: outputSchema },
          required: ["items"],
          type: "object",
        },
        threadId: "fake-thread",
      },
    });
    expect(
      requests.find((request) => request.method === "thread/start"),
    ).toMatchObject({
      params: {
        config: {
          model_reasoning_effort: "max",
          web_search: "disabled",
        },
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        sandbox: "read-only",
      },
    });
    expect(
      requests.find((request) => request.id === "server-request-1"),
    ).toMatchObject({
      error: {
        code: -32601,
        message: "Unsupported app-server request: fake/request",
      },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function readRequests(requestLog: string) {
  return (await readFile(requestLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const fakeCodexAppServer = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

log({ argv: process.argv.slice(2) });

const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const request = JSON.parse(line);
  log(request);

  if (request.id === "server-request-1" && request.error) {
    completeNormalTurn();
    return;
  }
  if (typeof request.id !== "number") return;
  if (request.method === "initialize") {
    respond(request.id, {});
  } else if (request.method === "thread/start") {
    respond(request.id, { thread: { id: "fake-thread" } });
  } else if (request.method === "thread/goal/clear") {
    notify("thread/goal/cleared", { threadId: "fake-thread" });
    respond(request.id, { cleared: true });
  } else if (request.method === "thread/goal/set") {
    runGoal();
    respond(request.id, {
      goal: { status: "complete", threadId: "fake-thread" }
    });
  } else if (request.method === "turn/start") {
    respond(request.id, { turn: { id: "fake-turn" } });
    process.stdout.write(JSON.stringify({
      id: "server-request-1",
      method: "fake/request",
      params: {}
    }) + "\\n");
  } else {
    respond(request.id, {});
  }
});

function runGoal() {
  notify("thread/goal/updated", {
    goal: { status: "active", threadId: "fake-thread" },
    threadId: "fake-thread",
    turnId: null
  });
  notify("turn/started", {
    threadId: "fake-thread",
    turn: { id: "fake-goal-turn-1", items: [], status: "inProgress" }
  });
  notify("item/completed", {
    item: { type: "agentMessage", text: "Still working." },
    threadId: "fake-thread",
    turnId: "fake-goal-turn-1"
  });
  notify("turn/completed", {
    threadId: "fake-thread",
    turn: { id: "fake-goal-turn-1", items: [], status: "completed" }
  });
  notify("turn/started", {
    threadId: "fake-thread",
    turn: { id: "fake-goal-turn-2", items: [], status: "inProgress" }
  });
  notify("item/completed", {
    item: { type: "agentMessage", text: "Goal complete." },
    threadId: "fake-thread",
    turnId: "fake-goal-turn-2"
  });
  notify("thread/goal/updated", {
    goal: { status: "complete", threadId: "fake-thread" },
    threadId: "fake-thread",
    turnId: "fake-goal-turn-2"
  });
  notify("turn/completed", {
    threadId: "fake-thread",
    turn: { id: "fake-goal-turn-2", items: [], status: "completed" }
  });
}

function completeNormalTurn() {
  notify("item/completed", {
    item: { type: "agentMessage", text: "{\\\"items\\\":[{\\\"finding_id\\\":7}]}" },
    threadId: "fake-thread",
    turnId: "fake-turn"
  });
  notify("turn/completed", {
    threadId: "fake-thread",
    turn: { id: "fake-turn", items: [], status: "completed" }
  });
}

function log(message) {
  if (process.env.FAKE_CODEX_REQUEST_LOG) {
    fs.appendFileSync(
      process.env.FAKE_CODEX_REQUEST_LOG,
      JSON.stringify(message) + "\\n"
    );
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ method, params }) + "\\n");
}
`;
