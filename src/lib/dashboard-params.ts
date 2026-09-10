export type FindingView =
  | "all-findings"
  | "ai-confirmed"
  | "duplicate"
  | "duplicate-groups"
  | "human-confirmed"
  | "human-rejected"
  | "needs-review"
  | "onchain-confirmed"
  | "pending";

export function parseFindingView(value?: string): FindingView {
  if (
    value === "all-findings" ||
    value === "ai-confirmed" ||
    value === "human-confirmed" ||
    value === "human-rejected" ||
    value === "needs-review" ||
    value === "onchain-confirmed"
  ) {
    return value;
  }
  if (value === "duplicate" || value === "duplicate-groups") return "duplicate";
  return "ai-confirmed";
}
