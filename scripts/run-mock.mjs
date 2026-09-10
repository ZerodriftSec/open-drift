import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = "http://localhost:7001";
let devServer;

function requestHeaders(hasBody = false) {
  const headers = new Headers();
  const platformToken = process.env.PLATFORM_TOKEN?.trim();
  if (platformToken) {
    headers.set("authorization", `Bearer ${platformToken}`);
  }
  if (hasBody) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

async function requestJson(path, init) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: requestHeaders(Boolean(init?.body)),
    });
  } catch {
    throw new Error(`Cannot reach ${baseUrl}.`);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      body.error ?? `Request failed with HTTP ${response.status}.`,
    );
  }
  return body;
}

async function appIsRunning() {
  try {
    await fetch(`${baseUrl}/api/version`, { headers: requestHeaders() });
    return true;
  } catch {
    return false;
  }
}

async function ensureAppIsRunning() {
  if (await appIsRunning()) {
    return false;
  }

  console.log("Starting open-drift...");
  const nextCli = path.join(
    process.cwd(),
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  let spawnError;
  devServer = spawn(process.execPath, [nextCli, "dev", "--port", "7001"], {
    env: process.env,
    stdio: "inherit",
  });
  devServer.once("error", (error) => {
    spawnError = error;
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => devServer?.kill(signal));
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (devServer.exitCode !== null) {
      throw new Error(`open-drift exited with code ${devServer.exitCode}.`);
    }
    if (await appIsRunning()) {
      return true;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for ${baseUrl}.`);
}

async function main() {
  const startedApp = await ensureAppIsRunning();
  const [{ workflows }, { agents }] = await Promise.all([
    requestJson("/api/workflows"),
    requestJson("/api/agents"),
  ]);
  const workflow = workflows?.find(({ id }) => id === "simple");
  if (!workflow) {
    throw new Error('Workflow "simple" is not available.');
  }

  const agent = agents?.find(
    ({ available, provider }) => available && provider === "codex",
  );
  if (!agent) {
    throw new Error("No available Codex agent was found.");
  }

  const agentAssignments = Object.fromEntries(
    workflow.stageIds.map((stageId) => [stageId, agent.id]),
  );
  const session = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      agentAssignments,
      projectName: "mock",
      projectSource: "local",
      run: true,
      source: "mock",
      workflowId: workflow.id,
    }),
  });

  console.log(`Mock audit queued with ${agent.displayName}.`);
  console.log(`${baseUrl}/sessions/${encodeURIComponent(session.sessionId)}`);

  if (startedApp) {
    console.log("open-drift is still running. Press Ctrl+C to stop it.");
    await new Promise((resolve) => devServer.once("exit", resolve));
  }
}

main().catch((error) => {
  if (devServer?.exitCode === null) {
    devServer.kill("SIGTERM");
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
