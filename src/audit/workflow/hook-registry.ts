import type { AuditSession } from "@/audit/session";

type WorkflowHook = (session: AuditSession) => Promise<void>;

export const workflowHookRegistry = {
  "render-findings-markdown-artifact": async (session) => {
    await session.renderFindingsMarkdownArtifact();
  },
} satisfies Record<string, WorkflowHook>;

export type WorkflowHookName = keyof typeof workflowHookRegistry;

export const workflowHookNames = Object.keys(workflowHookRegistry) as [
  WorkflowHookName,
  ...WorkflowHookName[],
];

export function isWorkflowHookName(value: string): value is WorkflowHookName {
  return Object.hasOwn(workflowHookRegistry, value);
}

export async function runWorkflowHooks(
  hooks: readonly string[],
  session: AuditSession,
) {
  for (const hook of hooks) {
    if (isWorkflowHookName(hook)) {
      await workflowHookRegistry[hook](session);
    }
  }
}
