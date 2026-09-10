import { BaseUsage, type UsageObservation } from "@/audit/agent/usage";

export class GeminiUsage extends BaseUsage {
  constructor(private readonly model: string) {
    super();
  }

  parse(rawMessage: unknown): readonly UsageObservation[] {
    const message = this.record(rawMessage);
    if (message?.event !== "prompt_response") return [];

    const payload = this.record(message.payload);
    const meta = this.record(payload?._meta);
    const quota = this.record(meta?.quota);
    const totals = this.record(quota?.token_count);
    return this.delta(
      {
        inputTokens: this.number(totals?.input_tokens),
        outputTokens: this.number(totals?.output_tokens),
      },
      this.model,
    );
  }
}
