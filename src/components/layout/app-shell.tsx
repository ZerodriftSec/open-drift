import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import {
  AppNavigation,
  type AppNavKey,
} from "@/components/layout/app-navigation";
import { isAuthenticationRequired } from "@/lib/auth/config";

type BreadcrumbItem = {
  href?: string;
  label: string;
};

export function AppShell({
  activeNav,
  breadcrumbs,
  children,
  headerAction,
  subtitle,
  title,
}: {
  activeNav: AppNavKey;
  breadcrumbs?: BreadcrumbItem[];
  children: ReactNode;
  headerAction?: ReactNode;
  subtitle?: string;
  title: string;
}) {
  const breadcrumbItems = breadcrumbs?.length
    ? breadcrumbs
    : [{ label: title }, ...(subtitle ? [{ label: subtitle }] : [])];

  return (
    <main className="grid h-dvh grid-cols-1 grid-rows-[52px_minmax(0,1fr)] overflow-hidden bg-app-surface-strong text-foreground md:grid-cols-[88px_minmax(0,1fr)] md:grid-rows-1">
      <AppNavigation
        activeNav={activeNav}
        authenticationRequired={isAuthenticationRequired()}
        title={title}
      />

      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background md:my-2 md:mr-2 md:rounded-app md:border md:border-app-border md:shadow-app">
        <header className="hidden h-[var(--header-h)] shrink-0 items-center justify-between gap-4 border-b border-app-border bg-app-surface px-5 md:flex">
          <nav
            aria-label="Current path"
            className="flex min-w-0 items-center gap-2.5 text-[13px]"
          >
            {breadcrumbItems.map((item, index) => {
              const isCurrent = index === breadcrumbItems.length - 1;

              return (
                <Fragment key={`${item.href ?? "current"}-${item.label}`}>
                  {index > 0 ? (
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-app-text-faint"
                    >
                      /
                    </span>
                  ) : null}
                  {isCurrent ? (
                    <h1 className="m-0 truncate font-medium text-app-text">
                      {item.label}
                    </h1>
                  ) : item.href ? (
                    <Link
                      className="app-breadcrumb-link shrink-0 text-app-text-muted transition-colors hover:text-app-text"
                      href={item.href}
                      prefetch={false}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span className="shrink-0 text-app-text-muted">
                      {item.label}
                    </span>
                  )}
                </Fragment>
              );
            })}
          </nav>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </header>

        {headerAction ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b border-app-border bg-app-surface p-3 md:hidden">
            {headerAction}
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </section>
    </main>
  );
}
