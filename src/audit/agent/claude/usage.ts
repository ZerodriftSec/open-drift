import { BaseUsage, type UsageObservation } from "@/audit/agent/usage";

export class ClaudeUsage extends BaseUsage {
  constructor(private readonly fallbackModel: string) {
    super();
  }

  parse(rawMessage: unknown): readonly UsageObservation[] {
    const raw = this.record(rawMessage);
    const message = raw?.type === "result" ? raw : this.record(raw?.payload);
    if (message?.type !== "result") return [];

    const scopeId = this.string(message.session_id);
    const modelUsage = this.record(message.modelUsage);
    const snapshots = Object.entries(modelUsage ?? {}).flatMap(
      ([model, value]) => {
        const usage = this.record(value);
        return this.snapshot(
          scopeId,
          {
            cacheReadInputTokens: this.number(usage?.cacheReadInputTokens),
            cacheWriteInputTokens: this.number(usage?.cacheCreationInputTokens),
            inputTokens: this.number(usage?.inputTokens),
            outputTokens: this.number(usage?.outputTokens),
            totalCostUsd: this.number(usage?.costUSD),
          },
          model,
        );
      },
    );
    if (snapshots.length > 0) return snapshots;

    const usage = this.record(message.usage);
    return this.snapshot(
      scopeId,
      {
        cacheReadInputTokens: this.number(usage?.cache_read_input_tokens),
        cacheWriteInputTokens: this.number(usage?.cache_creation_input_tokens),
        inputTokens: this.number(usage?.input_tokens),
        outputTokens: this.number(usage?.output_tokens),
        totalCostUsd: this.number(message.total_cost_usd),
      },
      this.fallbackModel,
    );
  }
}
