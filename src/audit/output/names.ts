export const workflowOutputSchemaNames = [
  "finding.submit",
  "finding.submit-confirmed",
  "finding.duplicate",
  "finding.review",
  "finding.onchain-confirm",
] as const;

export type WorkflowOutputSchemaName =
  (typeof workflowOutputSchemaNames)[number];

export function isWorkflowOutputSchemaName(
  value: string,
): value is WorkflowOutputSchemaName {
  return (workflowOutputSchemaNames as readonly string[]).includes(value);
}

export const legacyFindingMcpOutputSchemas = {
  "submit-finding": "finding.submit",
  "submit-confirmed-finding": "finding.submit-confirmed",
  "duplicate-finding": "finding.duplicate",
  "review-finding": "finding.review",
  "onchain-confirm-finding": "finding.onchain-confirm",
} as const satisfies Record<string, WorkflowOutputSchemaName>;

export type LegacyFindingMcpName = keyof typeof legacyFindingMcpOutputSchemas;

export function isLegacyFindingMcpName(
  value: string,
): value is LegacyFindingMcpName {
  return Object.hasOwn(legacyFindingMcpOutputSchemas, value);
}

export function legacyFindingOutputSchema(
  mcp: readonly string[] | undefined,
): WorkflowOutputSchemaName | undefined {
  const schemas = new Set(
    (mcp ?? [])
      .filter(isLegacyFindingMcpName)
      .map((name) => legacyFindingMcpOutputSchemas[name]),
  );

  return schemas.size === 1 ? schemas.values().next().value : undefined;
}
