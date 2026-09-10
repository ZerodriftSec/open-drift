"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { Toaster } from "sonner";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: {
            retry: 0,
          },
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 5_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        closeButton
        position="bottom-right"
        richColors
        toastOptions={{
          classNames: {
            actionButton: "!bg-primary !text-primary-foreground",
            cancelButton: "!bg-muted !text-muted-foreground",
            description: "!text-muted-foreground",
            toast: "!border-border !bg-popover !text-popover-foreground",
          },
        }}
      />
    </QueryClientProvider>
  );
}
