import { AcpAgent, type AcpRuntimeDefinition } from "@/audit/agent/acp";
import { copyAuditSkills } from "@/audit/agent/skills";
import {
  AgentProvider,
  ModelProvider,
  type GeminiAgentDefinition,
} from "@/audit/agent/types";
import type { WorkflowSkillSelection } from "@/audit/workflow";

export enum GeminiModel {
  GEMINI_3_7_FLASH = "gemini-3.7-flash",
}

export enum GeminiReasoningEffort {
  HIGH = "high",
}

export const geminiModels = {
  [GeminiModel.GEMINI_3_7_FLASH]: {
    displayName: "3.7 Flash",
  },
} as const satisfies Record<GeminiModel, { displayName: string }>;

export const geminiReasoningEfforts = {
  [GeminiReasoningEffort.HIGH]: {
    displayName: "high",
  },
} as const satisfies Record<GeminiReasoningEffort, { displayName: string }>;

export const geminiAgentDefinitions = [
  {
    modelProvider: ModelProvider.GEMINI,
    provider: AgentProvider.GEMINI,
    model: GeminiModel.GEMINI_3_7_FLASH,
    reasoningEffort: GeminiReasoningEffort.HIGH,
  },
] as const satisfies readonly {
  modelProvider: ModelProvider.GEMINI;
  provider: AgentProvider.GEMINI;
  model: GeminiModel;
  reasoningEffort: GeminiReasoningEffort;
}[];

export class GeminiAgent extends AcpAgent {
  readonly id: string;

  constructor(private readonly definition: GeminiAgentDefinition) {
    super();
    this.id = definition.id;
  }

  async copySkillsToWorkingDirectory(
    targetPath: string,
    skills?: WorkflowSkillSelection,
  ): Promise<void> {
    await copyAuditSkills({
      targetPath,
      agentConfigDirName: ".gemini",
      skills,
    });
  }

  protected createRuntime(): AcpRuntimeDefinition {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required for the Gemini Agent");
    }

    return {
      command: process.env.GEMINI_CLI_PATH?.trim() || "gemini",
      args: ["--acp", "--yolo", "--model", this.definition.model],
      env: {
        GEMINI_API_KEY: apiKey,
        GOOGLE_GENAI_USE_VERTEXAI: "false",
      },
      terminalErrorAdapter: (message) => {
        const locationError = message.match(
          /User location is not supported for the API use\.?/i,
        );
        return locationError
          ? `Gemini API rejected the request: ${locationError[0]}`
          : undefined;
      },
    };
  }
}
