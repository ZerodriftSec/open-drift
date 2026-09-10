import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { queueSettings, sessionQueueItems } from "@/server/db/schema";

const DEFAULT_QUEUE_CONCURRENCY = 1;

export type QueueItem = {
  key: string;
  sessionId: string;
};

export type QueueSetting = {
  key: string;
  concurrency: number;
};

export type QueueSnapshot = {
  defaultConcurrency: number;
  generatedAt: string;
  queues: Array<{
    activeCount: number;
    concurrency: number;
    idle: boolean;
    key: string;
    queuedCount: number;
    totalCount: number;
  }>;
  totals: {
    activeCount: number;
    queueCount: number;
    queuedCount: number;
    totalCount: number;
  };
};

export type QueueStore = {
  acknowledge(item: QueueItem): Promise<void>;
  insert(item: QueueItem): Promise<void>;
  claim(item: QueueItem): Promise<QueueItem | undefined>;
  deleteBySessionId(sessionId: string): Promise<number>;
  fail(item: QueueItem, error: string): Promise<void>;
  listItems(): Promise<QueueItem[]>;
  listSettings(): Promise<QueueSetting[]>;
  setConcurrency(setting: QueueSetting): Promise<void>;
};

export function createQueueStore(): QueueStore {
  return {
    async acknowledge(item) {
      await (
        await getDb()
      )
        .delete(sessionQueueItems)
        .where(
          and(
            eq(sessionQueueItems.key, item.key),
            eq(sessionQueueItems.sessionId, item.sessionId),
            eq(sessionQueueItems.status, "claimed"),
          ),
        )
        .run();
    },

    async insert(item) {
      await (
        await getDb()
      )
        .insert(sessionQueueItems)
        .values({
          id: randomUUID(),
          key: item.key,
          sessionId: item.sessionId,
          status: "queued",
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing({ target: sessionQueueItems.sessionId })
        .run();
    },

    async claim(item) {
      const claimedAt = new Date().toISOString();
      const row = await (
        await getDb()
      )
        .update(sessionQueueItems)
        .set({ claimedAt, error: null, status: "claimed" })
        .where(
          and(
            eq(sessionQueueItems.key, item.key),
            eq(sessionQueueItems.sessionId, item.sessionId),
            eq(sessionQueueItems.status, "queued"),
          ),
        )
        .returning()
        .get();
      return row ? { key: row.key, sessionId: row.sessionId } : undefined;
    },

    async deleteBySessionId(sessionId) {
      const rows = await (
        await getDb()
      )
        .delete(sessionQueueItems)
        .where(eq(sessionQueueItems.sessionId, sessionId))
        .returning({ id: sessionQueueItems.id })
        .all();
      return rows.length;
    },

    async fail(item, error) {
      await (
        await getDb()
      )
        .update(sessionQueueItems)
        .set({ error, status: "failed" })
        .where(
          and(
            eq(sessionQueueItems.key, item.key),
            eq(sessionQueueItems.sessionId, item.sessionId),
            eq(sessionQueueItems.status, "claimed"),
          ),
        )
        .run();
    },

    async listItems() {
      const rows = await (
        await getDb()
      )
        .select()
        .from(sessionQueueItems)
        .where(eq(sessionQueueItems.status, "queued"))
        .orderBy(asc(sessionQueueItems.createdAt))
        .all();
      return rows.map((row) => ({ key: row.key, sessionId: row.sessionId }));
    },

    async listSettings() {
      return (await getDb()).select().from(queueSettings).all();
    },

    async setConcurrency(setting) {
      await (
        await getDb()
      )
        .insert(queueSettings)
        .values(setting)
        .onConflictDoUpdate({
          target: queueSettings.key,
          set: { concurrency: setting.concurrency },
        })
        .run();
    },
  };
}

export type QueueConsumerControl = {
  markStarted(): Promise<void>;
};

export type QueueConsumer = (
  item: QueueItem,
  control: QueueConsumerControl,
) => Promise<void>;

export type QueueOptions = {
  acknowledgeOnStart?: boolean;
  onError?: (error: unknown, item: QueueItem) => void | Promise<void>;
};

type KeyRuntime = {
  running: number;
  pumping: boolean;
  repumpRequested: boolean;
};

export class Queue {
  private readonly store: QueueStore;
  private readonly options: QueueOptions;
  private readonly runtimes = new Map<string, KeyRuntime>();
  private readonly concurrencyCache = new Map<string, number>();
  private readonly runtimeQueueKeys = new Set<string>();
  private consumer: QueueConsumer | undefined;
  private bootstrapped = false;

  constructor(store: QueueStore, options: QueueOptions = {}) {
    this.store = store;
    this.options = options;
  }

  async enqueue(item: QueueItem): Promise<QueueItem> {
    await this.store.insert(item);
    this.runtimeQueueKeys.add(item.key);
    void this.pump(item.key);
    return item;
  }

  consume(consumer: QueueConsumer): void {
    this.consumer = consumer;
    void this.bootstrap().then(() => {
      for (const key of this.runtimeQueueKeys) {
        void this.pump(key);
      }
    });
  }

  async setConcurrency(key: string, concurrency: number): Promise<void> {
    const normalized = Math.max(1, Math.floor(concurrency));
    this.concurrencyCache.set(key, normalized);
    await this.store.setConcurrency({ key, concurrency: normalized });
    void this.pump(key);
  }

  async getConcurrency(key: string): Promise<number> {
    const cached = this.concurrencyCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    await this.refreshConcurrency();
    return this.concurrencyCache.get(key) ?? DEFAULT_QUEUE_CONCURRENCY;
  }

  async getSnapshot(): Promise<QueueSnapshot> {
    const [items, settings] = await Promise.all([
      this.store.listItems(),
      this.store.listSettings(),
    ]);
    const concurrencyByKey = new Map(
      settings.map((setting) => [setting.key, setting.concurrency]),
    );
    const keys = new Set([
      ...items.map((item) => item.key),
      ...settings.map((setting) => setting.key),
      ...this.runtimes.keys(),
    ]);
    const queues = [...keys].sort().map((key) => {
      const activeCount = this.runtimes.get(key)?.running ?? 0;
      const queuedCount = items.filter((item) => item.key === key).length;
      const totalCount = activeCount + queuedCount;

      return {
        activeCount,
        concurrency: concurrencyByKey.get(key) ?? DEFAULT_QUEUE_CONCURRENCY,
        idle: totalCount === 0,
        key,
        queuedCount,
        totalCount,
      };
    });
    const totals = queues.reduce(
      (result, queue) => ({
        activeCount: result.activeCount + queue.activeCount,
        queuedCount: result.queuedCount + queue.queuedCount,
        totalCount: result.totalCount + queue.totalCount,
      }),
      { activeCount: 0, queuedCount: 0, totalCount: 0 },
    );

    return {
      defaultConcurrency: DEFAULT_QUEUE_CONCURRENCY,
      generatedAt: new Date().toISOString(),
      queues,
      totals: { ...totals, queueCount: queues.length },
    };
  }

  async removeSession(sessionId: string): Promise<number> {
    return this.store.deleteBySessionId(sessionId);
  }

  private async refreshConcurrency(): Promise<void> {
    const settings = await this.store.listSettings();
    for (const setting of settings) {
      this.concurrencyCache.set(setting.key, setting.concurrency);
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.bootstrapped) {
      return;
    }
    this.bootstrapped = true;
    const [items] = await Promise.all([
      this.store.listItems(),
      this.refreshConcurrency(),
    ]);
    for (const item of items) {
      this.runtimeQueueKeys.add(item.key);
    }
  }

  private getRuntime(key: string): KeyRuntime {
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = { running: 0, pumping: false, repumpRequested: false };
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  private async pump(key: string): Promise<void> {
    if (!this.consumer) {
      return;
    }
    const runtime = this.getRuntime(key);
    if (runtime.pumping) {
      runtime.repumpRequested = true;
      return;
    }
    runtime.pumping = true;
    runtime.repumpRequested = false;
    try {
      const limit = await this.getConcurrency(key);
      while (runtime.running < limit) {
        const next = await this.claimNext(key);
        if (!next) {
          break;
        }
        runtime.running += 1;
        void this.runItem(key, next);
      }
    } finally {
      runtime.pumping = false;
      if (runtime.repumpRequested) {
        void this.pump(key);
      }
    }
  }

  private async claimNext(key: string): Promise<QueueItem | undefined> {
    const items = await this.store.listItems();
    for (const candidate of items) {
      if (candidate.key !== key) {
        continue;
      }
      const claimed = await this.store.claim(candidate);
      if (claimed) {
        return claimed;
      }
    }
    return undefined;
  }

  private async runItem(key: string, item: QueueItem): Promise<void> {
    const runtime = this.getRuntime(key);
    const consumer = this.consumer;
    let started = false;
    const control: QueueConsumerControl = {
      markStarted: async () => {
        if (started) return;
        await this.store.acknowledge(item);
        started = true;
      },
    };
    try {
      if (!this.options.acknowledgeOnStart) {
        await control.markStarted();
      }
      await consumer?.(item, control);
      if (!started) {
        await control.markStarted();
      }
    } catch (error) {
      if (!started) {
        await this.store.fail(item, errorMessage(error));
      }
      await this.options.onError?.(error, item);
    } finally {
      runtime.running -= 1;
      void this.pump(key);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
