import { z } from "zod";

export const findingNoteMaxLength = 4_000;

export const findingReviewUpdateSchema = z.object({
  action: z.enum(["confirm", "pass", "reset"]),
  findingId: z.coerce.number().int().positive(),
});

export const findingNoteUpdateSchema = z.object({
  findingId: z.coerce
    .number()
    .int()
    .positive()
    .describe("Persisted numeric finding ID."),
  note: z
    .string()
    .max(findingNoteMaxLength)
    .transform((value) => value.trim())
    .describe("Human-authored note. An empty value clears the note."),
});

export const findingNoteFormSchema = findingNoteUpdateSchema.extend({
  findingView: z
    .enum([
      "ai-confirmed",
      "duplicate-groups",
      "human-confirmed",
      "human-rejected",
      "onchain-confirmed",
      "pending",
    ])
    .optional()
    .describe("Findings view to return to after saving."),
});

export const findingStateQuerySchema = z.object({
  findingId: z.coerce
    .number()
    .int()
    .positive()
    .describe("Persisted numeric finding ID."),
  findingKey: z.string().min(1).describe("Stable finding key to inspect."),
});
