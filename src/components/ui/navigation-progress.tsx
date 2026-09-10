"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

type NavState = "idle" | "loading" | "completing";

function routeKey(pathname: string, search = "") {
  return search ? `${pathname}?${search}` : pathname;
}

function isSameOriginUrl(rawHref: string, currentOrigin: string): URL | null {
  if (!rawHref) return null;
  if (rawHref.startsWith("#")) return null;
  if (rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) return null;
  try {
    const url = new URL(rawHref, window.location.href);
    if (url.origin !== currentOrigin) return null;
    return url;
  } catch {
    return null;
  }
}

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [state, setState] = useState<NavState>("idle");
  const timeoutRef = useRef<number | null>(null);
  const targetKeyRef = useRef<string | null>(null);

  const clearTimeout = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => {
    function shouldIgnoreTarget(target: HTMLAnchorElement) {
      const download = target.getAttribute("download");
      if (download !== null) return true;
      const rel = target.getAttribute("rel") ?? "";
      if (rel.split(/\s+/).includes("external")) return true;
      return false;
    }

    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey)
        return;

      const target = (
        event.target as HTMLElement | null
      )?.closest<HTMLAnchorElement>("a[href]");
      if (!target) return;
      if (shouldIgnoreTarget(target)) return;

      const rawHref = target.getAttribute("href");
      if (!rawHref) return;

      const url = isSameOriginUrl(rawHref, window.location.origin);
      if (!url) return;

      const targetKey = routeKey(url.pathname, url.searchParams.toString());
      const currentKey = routeKey(
        window.location.pathname,
        window.location.search.slice(1),
      );

      if (targetKey === currentKey) {
        if (url.hash && url.hash !== window.location.hash) return;
        return;
      }

      targetKeyRef.current = targetKey;
      setState("loading");
      clearTimeout();
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (state === "idle") return;
    const key = routeKey(pathname ?? "", searchParams?.toString() ?? "");
    if (targetKeyRef.current === null) return;
    if (key === targetKeyRef.current) {
      targetKeyRef.current = null;
      setState("completing");
      clearTimeout();
      timeoutRef.current = window.setTimeout(() => {
        setState("idle");
      }, 260);
    }
  }, [pathname, searchParams, state]);

  useEffect(() => {
    return () => clearTimeout();
  }, []);

  if (state === "idle") return null;

  return (
    <div className="nav-progress" data-state={state} aria-hidden="true">
      <div className="nav-progress__bar" />
    </div>
  );
}
