import { afterEach, describe, expect, test, vi } from "vitest";

import { Queue, createQueueStore, type QueueItem } from "@/audit/queue";
import { ClaudeModel } from "@/audit/agent/claude";
import { listAgentDefinitions } from "@/audit/agent/registry";
import { AgentProvider, ModelProvider } from "@/audit/agent/types";
import { modelProviderQueueKey } from "@/audit/queue/model-provider-key";

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function makeSemaphore() {
  let active = 0;
  let max = 0;
  let completed = 0;
  return {
    get active() {
      return active;
    },
    get max() {
      return max;
    },
    get completed() {
      return completed;
    },
    async track<T>(fn: () => Promise<T>): Promise<T> {
      active += 1;
      if (active > max) {
        max = active;
      }
      try {
        return await fn();
      } finally {
        active -= 1;
        completed += 1;
      }
    },
  };
}

async function drainKey(key: string, expected: number) {
  await vi.waitFor(
    async () => {
      const items = (await createQueueStore().listItems()).filter(
        (item) => item.key === key,
      );
      expect(items).toHaveLength(0);
    },
    { timeout: 3000 },
  );
  expect(expected).toBeGreaterThan(0);
}

afterEach(async () => {
  const store = createQueueStore();
  const items = await store.listItems();
  await Promise.all(
    items.map((item) => store.deleteBySessionId(item.sessionId)),
  );
});

describe("Queue", () => {
  test("consumer receives enqueued item", async () => {
    const queue = new Queue(createQueueStore());
    const processed: QueueItem[] = [];

    queue.consume(async (item) => {
      processed.push(item);
    });

    await queue.enqueue({ key: "basic", sessionId: "session-basic-1" });

    await vi.waitFor(() => {
      expect(processed).toHaveLength(1);
    });

    expect(processed[0]).toEqual({
      key: "basic",
      sessionId: "session-basic-1",
    });

    await drainKey("basic", 1);
  });

  test("items within a key are processed FIFO", async () => {
    const queue = new Queue(createQueueStore());
    const order: string[] = [];
    let gate: () => void = () => {};
    const gatePromise = new Promise<void>((resolve) => {
      gate = resolve;
    });

    queue.consume(async (item) => {
      await gatePromise;
      order.push(item.sessionId);
    });

    await queue.enqueue({ key: "fifo", sessionId: "fifo-1" });
    await queue.enqueue({ key: "fifo", sessionId: "fifo-2" });
    await queue.enqueue({ key: "fifo", sessionId: "fifo-3" });

    gate();
    await vi.waitFor(() => {
      expect(order).toHaveLength(3);
    });

    expect(order).toEqual(["fifo-1", "fifo-2", "fifo-3"]);

    await drainKey("fifo", 3);
  });

  test("default concurrency is 1 per key", async () => {
    const queue = new Queue(createQueueStore());
    const sem = makeSemaphore();

    queue.consume(async (item) => {
      await sem.track(async () => {
        await delay(20);
        return item;
      });
    });

    for (let i = 0; i < 4; i += 1) {
      await queue.enqueue({ key: "default-conc", sessionId: `dc-${i}` });
    }

    await vi.waitFor(() => {
      expect(sem.max).toBe(1);
    });

    await vi.waitFor(() => {
      expect(sem.completed).toBe(4);
    });
    expect(sem.max).toBe(1);
  });

  test("per-key concurrency override raises the in-flight limit", async () => {
    const queue = new Queue(createQueueStore());
    const sem = makeSemaphore();

    queue.consume(async (item) => {
      await sem.track(async () => {
        await delay(30);
        return item;
      });
    });

    await queue.setConcurrency("raised", 3);

    for (let i = 0; i < 6; i += 1) {
      await queue.enqueue({ key: "raised", sessionId: `r-${i}` });
    }

    await vi.waitFor(() => {
      expect(sem.max).toBe(3);
    });

    await vi.waitFor(() => {
      expect(sem.completed).toBe(6);
    });
    expect(sem.max).toBe(3);
  });

  test("different keys keep independent concurrency limits", async () => {
    const queue = new Queue(createQueueStore());
    const active = { low: 0, high: 0 };
    const max = { low: 0, high: 0 };
    const completed = { low: 0, high: 0 };

    queue.consume(async (item) => {
      const bucket = item.key as "low" | "high";
      active[bucket] += 1;
      if (active[bucket] > max[bucket]) {
        max[bucket] = active[bucket];
      }
      await delay(25);
      active[bucket] -= 1;
      completed[bucket] += 1;
    });

    await queue.setConcurrency("low", 1);
    await queue.setConcurrency("high", 3);

    for (let i = 0; i < 4; i += 1) {
      await queue.enqueue({ key: "low", sessionId: `l-${i}` });
      await queue.enqueue({ key: "high", sessionId: `h-${i}` });
    }

    await vi.waitFor(() => {
      expect(max.low).toBe(1);
      expect(max.high).toBe(3);
    });

    await vi.waitFor(() => {
      expect(completed.low + completed.high).toBe(8);
    });
    expect(max.low).toBe(1);
    expect(max.high).toBe(3);
  });

  test("groups queue keys by model provider", () => {
    const definitions = listAgentDefinitions();

    for (const modelProvider of Object.values(ModelProvider)) {
      const agentIds = definitions
        .filter((agent) => agent.modelProvider === modelProvider)
        .map((agent) => agent.id);
      expect(agentIds.length).toBeGreaterThan(0);
      expect(modelProviderQueueKey(agentIds)).toBe(modelProvider);
    }

    expect(
      definitions.filter((agent) => agent.modelProvider === ModelProvider.GLM)
        .length,
    ).toBeGreaterThan(1);
    expect(
      definitions.filter((agent) => agent.modelProvider === ModelProvider.GPT)
        .length,
    ).toBeGreaterThan(1);
  });

  test("different model providers can run the same workflow concurrently", async () => {
    const definitions = listAgentDefinitions();
    const deepSeek = definitions.find(
      (agent) =>
        agent.provider === AgentProvider.CLAUDE &&
        agent.model === ClaudeModel.DEEPSEEK_V4_FLASH,
    );
    const glm = definitions.find(
      (agent) =>
        agent.provider === AgentProvider.CLAUDE &&
        agent.model === ClaudeModel.GLM_5_3,
    );
    if (!deepSeek || !glm) {
      throw new Error("Expected DeepSeek and GLM-5.3 Agent definitions.");
    }

    const glm47 = definitions.find(
      (agent) =>
        agent.provider === AgentProvider.CLAUDE &&
        agent.model === ClaudeModel.GLM_4_5_AIR,
    );
    if (!glm47) {
      throw new Error("Expected a GLM-4.7 Agent definition.");
    }

    const deepSeekKey = modelProviderQueueKey([deepSeek.id]);
    const glmKey = modelProviderQueueKey([glm.id]);
    expect(deepSeekKey).toBe(ModelProvider.DEEPSEEK);
    expect(glmKey).toBe(ModelProvider.GLM);
    expect(modelProviderQueueKey([glm.id, glm47.id])).toBe(ModelProvider.GLM);
    expect(modelProviderQueueKey([glm.id, deepSeek.id, glm.id])).toBe(
      "deepseek+glm",
    );

    const queue = new Queue(createQueueStore());
    const started: string[] = [];
    let completed = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.consume(async (item) => {
      started.push(item.key);
      await gate;
      completed += 1;
    });

    await queue.enqueue({ key: deepSeekKey, sessionId: "deepseek-workflow-1" });
    await queue.enqueue({ key: glmKey, sessionId: "glm-workflow-1" });

    await vi.waitFor(() => {
      expect(started).toEqual(expect.arrayContaining([deepSeekKey, glmKey]));
      expect(started).toHaveLength(2);
    });

    release();
    await vi.waitFor(() => {
      expect(completed).toBe(2);
    });
  });

  test("setConcurrency persists across new Queue instances", async () => {
    const key = "persisted";
    await new Queue(createQueueStore()).setConcurrency(key, 4);

    const queue = new Queue(createQueueStore());
    await expect(queue.getConcurrency(key)).resolves.toBe(4);
  });

  test("enqueue before consume is processed once consumer attaches", async () => {
    const queue = new Queue(createQueueStore());
    const processed: QueueItem[] = [];

    await queue.enqueue({ key: "early", sessionId: "early-1" });

    queue.consume(async (item) => {
      processed.push(item);
    });

    await vi.waitFor(() => {
      expect(processed).toHaveLength(1);
    });

    expect(processed[0]).toEqual({
      key: "early",
      sessionId: "early-1",
    });

    await drainKey("early", 1);
  });

  test("a new Queue instance resumes persisted items", async () => {
    const store = createQueueStore();
    const previousRuntime = new Queue(store);
    const item = { key: "restart", sessionId: "restart-1" };
    await previousRuntime.enqueue(item);

    const restartedRuntime = new Queue(store);
    const processed: QueueItem[] = [];
    restartedRuntime.consume(async (queuedItem) => {
      processed.push(queuedItem);
    });

    await vi.waitFor(() => {
      expect(processed).toEqual([item]);
    });

    expect(await store.listItems()).not.toContainEqual(item);
  });

  test("consumer errors do not stall the queue", async () => {
    const errors: unknown[] = [];
    const processed: string[] = [];

    const queue = new Queue(createQueueStore(), {
      onError: (error) => {
        errors.push(error);
      },
    });

    queue.consume(async (item) => {
      if (item.sessionId === "fail") {
        throw new Error("boom");
      }
      processed.push(item.sessionId);
    });

    await queue.enqueue({ key: "err", sessionId: "fail" });
    await queue.enqueue({ key: "err", sessionId: "ok" });

    await vi.waitFor(() => {
      expect(processed).toContain("ok");
      expect(errors).toHaveLength(1);
    });

    await drainKey("err", 2);
  });

  test("removeSession deletes pending items", async () => {
    const queue = new Queue(createQueueStore());
    const processed: string[] = [];

    let gate: () => void = () => {};
    const gatePromise = new Promise<void>((resolve) => {
      gate = resolve;
    });

    queue.consume(async (item) => {
      await gatePromise;
      processed.push(item.sessionId);
    });

    await queue.enqueue({ key: "remove", sessionId: "will-claim" });
    await queue.enqueue({ key: "remove", sessionId: "will-remove" });
    await queue.enqueue({ key: "remove", sessionId: "will-keep" });

    const deleted = await queue.removeSession("will-remove");
    expect(deleted).toBe(1);

    gate();
    await vi.waitFor(() => {
      expect(processed).toContain("will-claim");
      expect(processed).toContain("will-keep");
    });

    expect(processed).not.toContain("will-remove");
  });
});
