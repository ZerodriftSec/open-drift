"use client";

import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type SelectOption = {
  disabled?: boolean;
  label: React.ReactNode;
  value: string;
};

export type SelectSeparator = {
  label?: string;
  type: "separator";
};

export type SelectItem = SelectOption | SelectSeparator;

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  containerClassName?: string;
  options: SelectItem[];
  size?: "sm" | "md";
};

const sizeClasses = {
  sm: "min-h-7 px-2 text-xs",
  md: "min-h-8 px-2.5 text-[13px]",
};

export function Select({
  className,
  containerClassName,
  options,
  size = "md",
  ...props
}: SelectProps) {
  return (
    <div
      data-slot="select-native"
      className={cn("relative inline-flex items-center", containerClassName)}
    >
      <select
        className={cn(
          "w-full appearance-none rounded-app border border-input bg-background pr-7 font-medium text-foreground shadow-xs transition-colors",
          "hover:border-app-border-strong focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20",
          "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
          sizeClasses[size],
          className,
        )}
        {...props}
      >
        {options.map((option, index) =>
          isSelectSeparator(option) ? (
            <option
              key={`separator-${index}-${option.label ?? "line"}`}
              disabled
              value={`__separator_${index}`}
            >
              {option.label ?? "----------------"}
            </option>
          ) : (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label as string}
            </option>
          ),
        )}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}

function isSelectSeparator(option: SelectItem): option is SelectSeparator {
  return "type" in option && option.type === "separator";
}
