import {
  contractStateMcpServerName,
  contractStateSnapshotToolName,
} from "./contract-state/catalog";

export { contractStateMcpServerName, contractStateSnapshotToolName };

export const auditSessionHeaderName = "X-Zerodrift-Session-Id";

export type WorkflowMcp = {
  headers: Record<string, string>;
  name: string;
  url: string;
};

type WorkflowMcpRegistration = {
  getUrl: () => Promise<string>;
  serverName: string;
};

export const workflowMcpRegistry = {
  "contract-state": {
    getUrl: async () =>
      (await import("./contract-state")).getContractStateMcpUrl(),
    serverName: contractStateMcpServerName,
  },
} satisfies Record<string, WorkflowMcpRegistration>;

export type WorkflowMcpName = keyof typeof workflowMcpRegistry;

export const workflowMcpNames = Object.keys(workflowMcpRegistry) as [
  WorkflowMcpName,
  ...WorkflowMcpName[],
];

export function isWorkflowMcpName(value: string): value is WorkflowMcpName {
  return Object.hasOwn(workflowMcpRegistry, value);
}

export function workflowMcpServerName(mcp: WorkflowMcpName) {
  return workflowMcpRegistry[mcp].serverName;
}

export async function resolveWorkflowMcpServers({
  mcp,
  sessionId,
}: {
  mcp: readonly string[];
  sessionId: string;
}): Promise<readonly WorkflowMcp[]> {
  const names = [...new Set(mcp.filter(isWorkflowMcpName))];
  const headers = { [auditSessionHeaderName]: sessionId };

  return Promise.all(
    names.map(async (name) => {
      const registration = workflowMcpRegistry[name];
      return {
        headers,
        name: registration.serverName,
        url: await registration.getUrl(),
      };
    }),
  );
}
