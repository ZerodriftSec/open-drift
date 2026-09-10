"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

type SessionCreatedRefreshProps = {
  createdSessionId?: string;
};

export function SessionCreatedRefresh({
  createdSessionId,
}: SessionCreatedRefreshProps) {
  const router = useRouter();
  const refreshedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      !createdSessionId ||
      refreshedSessionIdRef.current === createdSessionId
    ) {
      return;
    }

    refreshedSessionIdRef.current = createdSessionId;
    router.refresh();

    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete("createdSessionId");
    const nextHref = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    router.replace(nextHref, {
      scroll: false,
    });
  }, [createdSessionId, router]);

  return null;
}
