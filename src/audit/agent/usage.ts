export type UsageAggregation = "delta" | "snapshot";

export type UsageTotals = {
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
};

export type UsageObservation = UsageTotals & {
  aggregation: UsageAggregation;
  model?: string;
  scopeId?: string;
};

/**
 * Provider-specific usage parsers normalize raw Agent log messages into a
 * shared representation when Session details are read.
 */
export abstract class BaseUsage {
  abstract parse(rawMessage: unknown): readonly UsageObservation[];

  protected delta(
    totals: UsageTotals,
    model?: string,
  ): readonly UsageObservation[] {
    const normalized = this.normalize(totals);
    return normalized
      ? [
          {
            aggregation: "delta",
            ...(model ? { model } : {}),
            ...normalized,
          },
        ]
      : [];
  }

  protected snapshot(
    scopeId: string | undefined,
    totals: UsageTotals,
    model?: string,
  ): readonly UsageObservation[] {
    const normalized = this.normalize(totals);
    return scopeId && normalized
      ? [
          {
            aggregation: "snapshot",
            ...(model ? { model } : {}),
            scopeId,
            ...normalized,
          },
        ]
      : [];
  }

  protected number(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  }

  protected record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  protected string(value: unknown) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private normalize(totals: UsageTotals): UsageTotals | undefined {
    const normalized = Object.fromEntries(
      Object.entries(totals).filter(([, value]) => value !== undefined),
    ) as UsageTotals;
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }
}
