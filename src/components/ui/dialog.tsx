"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

type DialogSize = "sm" | "md" | "lg";

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export function Dialog({
  children,
  className,
  onOpenChange,
  open,
  size = "md",
}: {
  children: ReactNode;
  className?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  size?: DialogSize;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                data-slot="dialog-overlay"
                className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-[1px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                data-slot="dialog-content"
                className={cn(
                  "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-app-lg border border-border bg-popover text-popover-foreground shadow-app-overlay outline-none",
                  sizeClasses[size],
                  className,
                )}
                initial={{ opacity: 0, scale: 0.98, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 8 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                {children}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

export function DialogHeader({
  children,
  description,
  onClose,
  title,
}: {
  children?: ReactNode;
  description?: ReactNode;
  onClose?: () => void;
  title: ReactNode;
}) {
  return (
    <div
      data-slot="dialog-header"
      className="flex items-start justify-between gap-3 border-b border-border px-4 py-3"
    >
      <div className="grid min-w-0 gap-0.5">
        <DialogPrimitive.Title asChild>
          <h2 className="m-0 text-[14px] font-semibold leading-tight text-popover-foreground">
            {title}
          </h2>
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description asChild>
            <p className="m-0 text-[12px] leading-snug text-muted-foreground">
              {description}
            </p>
          </DialogPrimitive.Description>
        ) : null}
        {children}
      </div>
      {onClose ? (
        <DialogPrimitive.Close asChild>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-app-sm border border-transparent text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/25"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </DialogPrimitive.Close>
      ) : null}
    </div>
  );
}

export function DialogBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DialogFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex items-center justify-end gap-2 border-t border-border bg-muted px-4 py-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}
