import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { testAgent } from "./mock-agent";
import { getContractStateMcpUrl } from "@/audit/mcp/contract-state";
import {
  auditSessionHeaderName,
  contractStateSnapshotToolName,
} from "@/audit/mcp/registry";
import { AuditSession } from "@/audit/session";
import { deleteSessionStateFromDb } from "@/server/db/store";
import {
  getDefaultWorkflowId,
  getWorkflowDefinition,
} from "@/server/workflows";

test("contract-state remains the only resident workflow MCP", async () => {
  const session = await createMcpTestSession();
  const url = await getContractStateMcpUrl();
  const client = new Client({ name: "zerodrift-test", version: "1.0.0" });

  try {
    expect(await getContractStateMcpUrl()).toBe(url);
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect((await fetch(url, { method: "POST" })).status).toBe(400);
    expect(
      (
        await fetch(url, {
          headers: { [auditSessionHeaderName]: "missing-session" },
          method: "POST",
        })
      ).status,
    ).toBe(404);

    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: { [auditSessionHeaderName]: session.sessionId },
        },
      }),
    );
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      contractStateSnapshotToolName,
    ]);
  } finally {
    await client.close().catch(() => undefined);
    await cleanupSession(session);
  }
});

async function createMcpTestSession() {
  const sourceDirectory = await mkdtemp(
    path.join(tmpdir(), "zerodrift-contract-state-mcp-"),
  );
  await writeFile(
    path.join(sourceDirectory, "Vault.sol"),
    "contract Vault {}\n",
    "utf8",
  );
  const workflow = await getWorkflowDefinition(await getDefaultWorkflowId());
  const session = await AuditSession.createAuditSession({
    agents: workflow.stages.map(() => testAgent),
    projectName: "contract-state-mcp",
    targetPath: sourceDirectory,
    workflow,
  });
  await session.copySourceToWorkingDirectory();
  return Object.assign(session, { sourceDirectory });
}

async function cleanupSession(
  session: AuditSession & { sourceDirectory: string },
) {
  await session.close();
  await deleteSessionStateFromDb(session.sessionId);
  await rm(session.sessionDirectoryPath, { force: true, recursive: true });
  await rm(session.sourceDirectory, { force: true, recursive: true });
}
