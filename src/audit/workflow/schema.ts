import { z } from "zod";
import { normalizeAgentId } from "@/audit/agent/registry";
import { workflowMcpNames } from "@/audit/mcp/registry";
import { workflowOutputSchemaNames } from "@/audit/output/names";
import { workflowHookNames } from "@/audit/workflow/hook-registry";

export const workflowMcpSchema = z.enum(workflowMcpNames);

export const workflowTurnHookSchema = z.enum(workflowHookNames);

export const workflowOutputSchemaNameSchema = z.enum(workflowOutputSchemaNames);

export const workflowDefaultModelSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        normalizeAgentId(value);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: "Workflow defaultModel must reference a registered Agent ID.",
    },
  );

export const workflowSkillSelectionSchema = z
  .object({
    names: z.array(z.string().trim().min(1)).optional(),
    prefixes: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const workflowPromptSchema = z
  .union([
    z.string(),
    z
      .array(z.string())
      .min(1)
      .transform((lines) => lines.join("\n")),
  ])
  .refine((prompt) => prompt.trim().length > 0, {
    message: "Workflow Turn prompt must not be empty.",
  });

export const workflowTurnDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    prompt: workflowPromptSchema,
    goal: z.boolean().optional(),
    skills: workflowSkillSelectionSchema.optional(),
    mcp: z.array(workflowMcpSchema).optional(),
    outputSchema: workflowOutputSchemaNameSchema.optional(),
    beforeHooks: z.array(workflowTurnHookSchema).optional(),
    afterHooks: z.array(workflowTurnHookSchema).optional(),
  })
  .strict();

export const workflowStageDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    dependsOn: z.array(z.string().trim().min(1)),
    threadMode: z.enum(["new", "fork", "resume"]),
    turns: z.array(workflowTurnDocumentSchema).min(1),
  })
  .strict();

export const workflowDocumentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60).optional(),
    defaultModel: workflowDefaultModelSchema.optional(),
    description: z.string().trim().max(2_000).optional(),
    stages: z.array(workflowStageDocumentSchema).min(1),
  })
  .strict();

export type WorkflowDocumentInput = z.infer<typeof workflowDocumentInputSchema>;
