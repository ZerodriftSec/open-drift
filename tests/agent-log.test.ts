import { expect, test } from "vitest";

import { agentLogMessage } from "@/lib/agent-log";

test("reads only normalized agent messages", () => {
  const messages = [
    { type: "user", content: "Audit this contract." },
    { type: "assistant", content: "The contract is safe." },
    { type: "reasoning", content: "Reviewing the contract." },
    {
      type: "tool_call",
      callId: "call-1",
      tool: "Read",
      input: { file_path: "Contract.sol" },
    },
  ] as const;

  for (const message of messages) {
    expect(agentLogMessage({ message })).toEqual(message);
  }
});

test("does not project provider-specific raw events", () => {
  expect(
    agentLogMessage({
      agent_message: {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Raw Claude response." }],
        },
      },
    }),
  ).toBeUndefined();
});
