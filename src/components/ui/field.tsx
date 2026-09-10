"use client";

import type {
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

const inputBaseClass =
  "w-full rounded-app border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs transition-colors placeholder:text-muted-foreground hover:border-app-border-strong focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

export function Field({
  children,
  className,
  error,
  hint,
  label,
}: {
  children: ReactNode;
  className?: string;
  error?: ReactNode;
  hint?: ReactNode;
  label?: ReactNode;
}) {
  return (
    <label className={cn("grid gap-1", className)}>
      {label ? (
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      ) : null}
      {children}
      {error ? (
        <span className="text-[11px] text-app-danger">{error}</span>
      ) : null}
      {!error && hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      data-slot="input"
      className={cn(inputBaseClass, "min-h-8", className)}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(inputBaseClass, "min-h-20 py-1.5", className)}
      {...props}
    />
  );
}
