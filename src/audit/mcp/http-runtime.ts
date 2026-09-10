import { readSessionStateFromDb } from "@/server/db/store";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { auditSessionHeaderName } from "./registry";

export async function startMcpHttpServer({
  createMcpServer,
}: {
  createMcpServer: (sessionId: string) => McpServer | Promise<McpServer>;
}) {
  const httpServer = createServer((request, response) => {
    handleRequest({ createMcpServer, request, response }).catch(
      (error: unknown) => {
        writeJsonRpcError(
          response,
          500,
          error instanceof Error ? error.message : "Internal server error",
        );
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  httpServer.unref();

  const address = httpServer.address();
  if (!isAddressInfo(address)) {
    throw new Error("MCP server did not bind to a TCP port");
  }

  return `http://127.0.0.1:${address.port}/mcp`;
}

async function handleRequest({
  createMcpServer,
  request,
  response,
}: {
  createMcpServer: (sessionId: string) => McpServer | Promise<McpServer>;
  request: IncomingMessage;
  response: ServerResponse;
}) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== "POST") {
    writeJsonRpcError(response, 405, "Method not allowed");
    return;
  }

  const sessionId = getHeaderString(
    request.headers[auditSessionHeaderName.toLowerCase()],
  )?.trim();
  if (!sessionId) {
    writeJsonRpcError(
      response,
      400,
      `Missing ${auditSessionHeaderName} header`,
    );
    return;
  }
  if (!(await readSessionStateFromDb(sessionId))) {
    writeJsonRpcError(response, 404, `AuditSession not found: ${sessionId}`);
    return;
  }

  const server = await createMcpServer(sessionId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= Promise.allSettled([
      transport.close(),
      server.close(),
    ]).then(() => undefined);
    return closePromise;
  };
  response.once("close", () => {
    void close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } finally {
    if (response.writableEnded) {
      await close();
    }
  }
}

function getHeaderString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function writeJsonRpcError(
  response: ServerResponse,
  statusCode: number,
  message: string,
) {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
      },
      id: null,
    }),
  );
}

function isAddressInfo(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return Boolean(address && typeof address === "object" && "port" in address);
}
