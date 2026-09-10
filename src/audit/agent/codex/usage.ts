import { BaseUsage, type UsageObservation } from "@/audit/agent/usage";

export class CodexUsage extends BaseUsage {
  constructor(private readonly model: string) {
    super();
  }

  parse(rawMessage: unknown): readonly UsageObservation[] {
    const notification = this.record(rawMessage);
    if (notification?.method !== "thread/tokenUsage/updated") return [];

    const params = this.record(notification.params);
    const tokenUsage = this.record(params?.tokenUsage);
    const totals = this.record(tokenUsage?.total);
    return this.snapshot(
      this.string(params?.threadId),
      {
        cacheReadInputTokens: this.number(totals?.cachedInputTokens),
        inputTokens: this.number(totals?.inputTokens),
        outputTokens: this.number(totals?.outputTokens),
        reasoningOutputTokens: this.number(totals?.reasoningOutputTokens),
      },
      this.model,
    );
  }
}
