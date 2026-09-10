import { expect, test, vi } from "vitest";
import pino from "pino";

import type { ThreadOptions } from "@/audit/agent/base-agent";
import { createAgent } from "@/audit/agent/registry";
import { createAgentMock, testAgent, testAgentLogEvents } from "./mock-agent";

test("createAgent returns the shared test Agent", () => {
  expect(createAgent("any-agent-id")).toBe(testAgent);
  expect(createAgentMock).toHaveBeenCalledWith("any-agent-id");
});

test("runQuery writes fixed JSON logs through pino", async () => {
  const logger = pino({ enabled: false });
  const logInfo = vi.spyOn(logger, "info");
  const options: ThreadOptions = {
    cwd: "/tmp/test-agent",
  };
  const prompts = ["Review this contract.", "Report any findings."];

  const result = testAgent.runQuery(prompts, options, logger);

  expect(result).toBeInstanceOf(Promise);
  await result;

  expect(testAgent.runQuery).toHaveBeenCalledWith(prompts, options, logger);
  expect(logInfo).toHaveBeenNthCalledWith(1, {
    agent_message: testAgentLogEvents[0],
  });
  expect(logInfo).toHaveBeenNthCalledWith(2, {
    agent_message: testAgentLogEvents[1],
  });
});
