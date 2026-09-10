"use client";

import {
  Bot,
  LayoutDashboard,
  Menu,
  Plus,
  ScrollText,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { UploadDialog } from "@/components/uploads/upload-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { sessionsPagePath } from "@/lib/page-routes";

export type AppNavKey = "apiDocs" | "dashboard" | "sessions" | "workflows";

type NavItem = {
  href: string;
  icon: LucideIcon;
  key: AppNavKey;
  label: string;
  newTab?: boolean;
};

const primaryNavItems: NavItem[] = [
  {
    href: "/dashboard",
    icon: LayoutDashboard,
    key: "dashboard",
    label: "Dashboard",
  },
  {
    href: sessionsPagePath(),
    icon: Bot,
    key: "sessions",
    label: "Sessions",
  },
  {
    href: "/workflows",
    icon: Workflow,
    key: "workflows",
    label: "Workflows",
  },
];

const secondaryNavItems: NavItem[] = [
  {
    href: "/api-docs",
    icon: ScrollText,
    key: "apiDocs",
    label: "API Docs",
    newTab: true,
  },
];

export function AppNavigation({
  activeNav,
  authenticationRequired,
  title,
}: {
  activeNav: AppNavKey;
  authenticationRequired: boolean;
  title: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  function openCreateDialog() {
    setMobileOpen(false);
    setCreateOpen(true);
  }

  return (
    <>
      <aside className="hidden min-h-0 flex-col items-center bg-app-surface-strong py-3 md:flex">
        <span
          aria-hidden="true"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] text-primary"
        >
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-app">
            <Bot className="h-4.5 w-4.5" />
          </span>
        </span>

        <Tooltip className="mt-5" content="Create audit task" side="right">
          <button
            aria-label="Create audit task"
            className="grid h-11 w-11 place-items-center rounded-[14px] border border-app-border-strong bg-app-surface text-app-text shadow-app transition-colors hover:border-app-primary-border hover:bg-app-primary-bg hover:text-primary"
            onClick={openCreateDialog}
            type="button"
          >
            <Plus className="h-5 w-5" aria-hidden="true" />
          </button>
        </Tooltip>

        <nav
          aria-label="Primary navigation"
          className="mt-8 grid w-full gap-1 px-2"
        >
          {primaryNavItems.map((item) => (
            <DesktopNavLink
              active={item.key === activeNav}
              item={item}
              key={item.key}
            />
          ))}
        </nav>

        <nav
          aria-label="Secondary navigation"
          className="mt-auto grid w-full gap-1 px-2"
        >
          {secondaryNavItems.map((item) => (
            <DesktopNavLink
              active={item.key === activeNav}
              item={item}
              key={item.key}
            />
          ))}
          {authenticationRequired ? <SignOutButton /> : null}
        </nav>
      </aside>

      <header className="relative z-40 flex h-[52px] shrink-0 items-center justify-between border-b border-app-border bg-app-surface px-3 md:hidden">
        <Link
          className="flex min-w-0 items-center gap-2"
          href={sessionsPagePath()}
          prefetch={false}
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-app bg-primary text-primary-foreground">
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="truncate text-[14px] font-semibold text-app-text">
            {title}
          </span>
        </Link>
        <button
          aria-expanded={mobileOpen}
          aria-label={
            mobileOpen ? "Close navigation menu" : "Open navigation menu"
          }
          className="grid h-8 w-8 place-items-center rounded-app border border-app-border bg-app-surface text-app-text-muted hover:bg-app-hover hover:text-app-text"
          onClick={() => setMobileOpen((open) => !open)}
          type="button"
        >
          {mobileOpen ? (
            <X className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Menu className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </header>

      <button
        aria-hidden={!mobileOpen}
        aria-label="Close navigation menu"
        className={cn(
          "fixed inset-x-0 bottom-0 top-[52px] z-30 bg-foreground/20 transition-opacity md:hidden",
          mobileOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
        onClick={() => setMobileOpen(false)}
        tabIndex={mobileOpen ? 0 : -1}
        type="button"
      />

      <div
        aria-hidden={!mobileOpen}
        className={cn(
          "fixed inset-x-2 top-[60px] z-40 grid gap-3 rounded-app-lg border border-app-border bg-app-surface p-2 shadow-app-overlay transition-[opacity,transform] md:hidden",
          mobileOpen
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-2 opacity-0",
        )}
      >
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-app bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-app-primary-hover"
          onClick={openCreateDialog}
          tabIndex={mobileOpen ? 0 : -1}
          type="button"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create task
        </button>
        <nav aria-label="Mobile primary navigation" className="grid gap-0.5">
          {[...primaryNavItems, ...secondaryNavItems].map((item) => (
            <MobileNavLink
              active={item.key === activeNav}
              item={item}
              key={item.key}
              onNavigate={() => setMobileOpen(false)}
              tabIndex={mobileOpen ? 0 : -1}
            />
          ))}
          {authenticationRequired ? <SignOutButton mobile /> : null}
        </nav>
      </div>

      <UploadDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

function DesktopNavLink({ active, item }: { active: boolean; item: NavItem }) {
  const Icon = item.icon;
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "grid min-h-14 justify-items-center gap-1 rounded-[14px] px-1 py-2 text-[10px] font-medium leading-tight transition-colors",
        active
          ? "bg-app-selected text-primary"
          : "text-app-text-muted hover:bg-app-hover hover:text-app-text",
      )}
      href={item.href}
      prefetch={false}
      rel={item.newTab ? "noopener noreferrer" : undefined}
      scroll={false}
      target={item.newTab ? "_blank" : undefined}
    >
      <Icon className="h-4.5 w-4.5" aria-hidden="true" strokeWidth={1.8} />
      <span className="max-w-full truncate">{item.label}</span>
    </Link>
  );
}

function MobileNavLink({
  active,
  item,
  onNavigate,
  tabIndex,
}: {
  active: boolean;
  item: NavItem;
  onNavigate: () => void;
  tabIndex: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-app px-3 text-[13px] font-medium",
        active
          ? "bg-app-selected text-primary"
          : "text-app-text-muted hover:bg-app-hover hover:text-app-text",
      )}
      href={item.href}
      onClick={onNavigate}
      prefetch={false}
      rel={item.newTab ? "noopener noreferrer" : undefined}
      scroll={false}
      tabIndex={tabIndex}
      target={item.newTab ? "_blank" : undefined}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}
