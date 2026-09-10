"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod";
import { ApiResponseError, requestJson } from "@/app/components/lib/api-client";

type SessionAutoRefreshProps = {
  enabled: boolean;
  initialLogOffset?: number;
  intervalMs?: number;
  sessionId?: string;
};

const missingSessionIds = new Set<string>();

export function SessionAutoRefresh({
  enabled,
  initialLogOffset,
  intervalMs = 5000,
  sessionId,
}: SessionAutoRefreshProps) {
  const router = useRouter();
  const refreshQueued = useRef(false);
  const lastStatusRef = useRef<string | null>(null);

  const queueRefresh = useCallback(() => {
    if (document.visibilityState !== "visible" || refreshQueued.current) {
      return;
    }

    refreshQueued.current = true;
    router.refresh();
    window.setTimeout(() => {
      refreshQueued.current = false;
    }, 250);
  }, [router]);

  const shouldPollSession =
    enabled && Boolean(sessionId) && !isKnownMissingSession(sessionId);
  const statusQuery = useQuery({
    enabled: shouldPollSession,
    queryFn: () =>
      requestJson(
        `/api/zerodrift/sessions/${encodeURIComponent(sessionId ?? "")}/status`,
        { method: "GET" },
        sessionStatusSchema,
        "Failed to refresh Session status",
      ),
    queryKey: ["session-status", sessionId],
    refetchInterval: (query) =>
      isNotFoundError(query.state.error) ? false : intervalMs,
    refetchIntervalInBackground: false,
    refetchOnMount: (query) => !isNotFoundError(query.state.error),
    refetchOnReconnect: (query) => !isNotFoundError(query.state.error),
    refetchOnWindowFocus: (query) => !isNotFoundError(query.state.error),
    retry: (failureCount, error) =>
      isNotFoundError(error) ? false : failureCount < 2,
  });

  useEffect(() => {
    if (!enabled || sessionId) {
      return;
    }

    const intervalId = window.setInterval(queueRefresh, intervalMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        queueRefresh();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, intervalMs, queueRefresh, sessionId]);

  useEffect(() => {
    lastStatusRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId || !isNotFoundError(statusQuery.error)) {
      return;
    }

    rememberMissingSession(sessionId);
    queueRefresh();
  }, [enabled, queueRefresh, sessionId, statusQuery.error]);

  useEffect(() => {
    if (!enabled || !sessionId || !statusQuery.data) {
      return;
    }

    const nextFingerprint = statusFingerprint(statusQuery.data);
    if (lastStatusRef.current === null) {
      lastStatusRef.current = nextFingerprint;
      return;
    }

    if (lastStatusRef.current !== nextFingerprint) {
      lastStatusRef.current = nextFingerprint;
      queueRefresh();
    }
  }, [enabled, queueRefresh, sessionId, statusQuery.data]);

  useEffect(() => {
    if (!enabled || !sessionId || typeof EventSource === "undefined") {
      return;
    }

    const source = new EventSource(
      `/api/sessions/${encodeURIComponent(sessionId)}/logs?format=stream&source=agent&after=${initialLogOffset ?? 0}`,
    );
    const handleLogChange = () => queueRefresh();

    source.addEventListener("logs", handleLogChange);
    source.addEventListener("rotated", handleLogChange);

    return () => {
      source.close();
    };
  }, [enabled, initialLogOffset, queueRefresh, sessionId]);

  return null;
}

const sessionStatusSchema = z
  .object({
    phase: z.string().optional(),
    progress: z
      .object({
        progress: z.number().optional(),
      })
      .optional(),
    status: z.string().optional(),
  })
  .passthrough();

function statusFingerprint(status: z.infer<typeof sessionStatusSchema>) {
  const record = status as Record<string, unknown>;
  return JSON.stringify({
    completed: record.completed,
    failed: record.failed,
    findingCount: record.findingCount,
    phase: status.phase,
    progress: status.progress?.progress,
    status: status.status,
  });
}

function isNotFoundError(error: unknown) {
  return error instanceof ApiResponseError && error.status === 404;
}

function isKnownMissingSession(sessionId: string | undefined) {
  return Boolean(sessionId && missingSessionIds.has(sessionId));
}

function rememberMissingSession(sessionId: string) {
  missingSessionIds.add(sessionId);
}
