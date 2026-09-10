"use client";

import type { AuditAgentDefinition } from "@/audit/agent/registry";
import { AgentProvider } from "@/audit/agent/types";
import { ChevronDown, Check } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

function baseColor(base?: string) {
  if (base === AgentProvider.CLAUDE)
    return { block: "bg-violet-500", label: "Claude" };
  if (base === AgentProvider.CODEX)
    return { block: "bg-emerald-500", label: "Codex" };
  if (base === AgentProvider.GEMINI)
    return { block: "bg-blue-500", label: "Gemini" };
  return { block: "bg-app-text-faint", label: "Agent" };
}

const agentKindLabels: Record<string, string> = {
  [AgentProvider.CLAUDE]: "Claude Code",
  [AgentProvider.CODEX]: "Codex",
  [AgentProvider.GEMINI]: "Gemini",
};

type AgentOptionGroup = {
  id: string;
  label: string;
  agents: AuditAgentDefinition[];
};

function compareModelVersionsNewestFirst(
  left: AuditAgentDefinition,
  right: AuditAgentDefinition,
) {
  const leftVersion = left.model.match(/\d+(?:\.\d+)*/)?.[0].split(".") ?? [];
  const rightVersion = right.model.match(/\d+(?:\.\d+)*/)?.[0].split(".") ?? [];
  const partCount = Math.max(leftVersion.length, rightVersion.length);

  for (let index = 0; index < partCount; index += 1) {
    const difference =
      Number(rightVersion[index] ?? 0) - Number(leftVersion[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function groupAgents(
  agents: AuditAgentDefinition[],
): AgentOptionGroup[] {
  const groups = new Map<string, AuditAgentDefinition[]>();
  for (const agent of agents) {
    const kind = agent.provider;
    const group = groups.get(kind);
    if (group) {
      group.push(agent);
    } else {
      groups.set(kind, [agent]);
    }
  }
  return [...groups.entries()].map(([id, groupAgents]) => ({
    id,
    label: agentKindLabels[id] ?? id,
    agents: [...groupAgents].sort(compareModelVersionsNewestFirst),
  }));
}

const DROPDOWN_HEIGHT = 320;
const DROPDOWN_MARGIN = 4;

function computePanelRect(button: HTMLElement) {
  const rect = button.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const openBelow =
    rect.bottom + DROPDOWN_HEIGHT + DROPDOWN_MARGIN <= viewportHeight;
  const availableBelow = Math.max(
    120,
    viewportHeight - rect.bottom - DROPDOWN_MARGIN * 2,
  );
  const availableAbove = Math.max(120, rect.top - DROPDOWN_MARGIN * 2);
  const maxHeight = Math.min(
    DROPDOWN_HEIGHT,
    openBelow ? availableBelow : availableAbove,
  );
  const top = openBelow
    ? rect.bottom + DROPDOWN_MARGIN
    : Math.max(DROPDOWN_MARGIN, rect.top - maxHeight - DROPDOWN_MARGIN);
  return { top, left: rect.left, maxHeight, width: rect.width };
}

export type AgentSelectProps = {
  agents: AuditAgentDefinition[];
  className?: string;
  containerClassName?: string;
  disabled?: boolean;
  emptyOptionLabel?: string;
  name?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "sm" | "md";
  value: string;
};

export function AgentSelect({
  agents,
  className,
  containerClassName,
  disabled,
  emptyOptionLabel,
  name,
  onChange,
  placeholder = "Select an Agent",
  size = "md",
  value,
}: AgentSelectProps) {
  const [open, setOpen] = useState(false);
  const [panelRect, setPanelRect] = useState<{
    top: number;
    left: number;
    maxHeight: number;
    width: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const groups = groupAgents(agents);
  const selectedAgent = agents.find((agent) => agent.id === value);

  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !buttonRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onScrollOrResize = (event: Event) => {
      if (
        event.type === "scroll" &&
        panelRef.current &&
        event.target instanceof Node &&
        panelRef.current.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, {
      signal: controller.signal,
    });
    document.addEventListener("keydown", onKey, { signal: controller.signal });
    window.addEventListener("resize", onScrollOrResize, {
      signal: controller.signal,
    });
    window.addEventListener("scroll", onScrollOrResize, {
      signal: controller.signal,
      capture: true,
    });
    return () => controller.abort();
  }, [open]);

  const handleToggle = () => {
    if (buttonRef.current) {
      setPanelRect(computePanelRect(buttonRef.current));
    }
    setOpen((current) => !current);
  };

  const sizeClasses = size === "sm" ? "min-h-7 text-xs" : "min-h-8 text-[13px]";

  return (
    <div
      className={cn("relative inline-flex items-center", containerClassName)}
    >
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        id={buttonId}
        onClick={handleToggle}
        className={cn(
          "inline-flex w-full items-center gap-1.5 rounded-app border border-input bg-background pr-7 font-medium text-foreground shadow-xs transition-colors",
          "hover:border-app-border-strong focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20",
          "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
          sizeClasses,
          className,
        )}
      >
        {selectedAgent ? (
          <>
            <AgentBaseBadge base={selectedAgent.provider} className="ml-1.5" />
            <span className="min-w-0 flex-1 truncate text-left">
              {selectedAgent.displayName}
            </span>
            {!selectedAgent.available ? (
              <span className="shrink-0 text-[11px] font-normal text-app-text-muted">
                Unavailable
              </span>
            ) : null}
          </>
        ) : (
          <span className="ml-2.5 min-w-0 flex-1 truncate text-left text-app-text-muted">
            {placeholder}
          </span>
        )}
        <ChevronDown
          className={cn(
            "pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {typeof document !== "undefined" && panelRect
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  key="agent-select-panel"
                  ref={panelRef}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                  role="listbox"
                  aria-labelledby={buttonId}
                  style={{
                    position: "fixed",
                    top: panelRect.top,
                    left: panelRect.left,
                    maxHeight: panelRect.maxHeight,
                    width: panelRect.width,
                    pointerEvents: "auto",
                  }}
                  onTouchMove={(event) => event.stopPropagation()}
                  onWheel={(event) => event.stopPropagation()}
                  className={cn(
                    "z-[60] overflow-y-auto overscroll-contain [scrollbar-gutter:stable] touch-pan-y",
                    "rounded-app border border-app-border bg-app-surface shadow-lg",
                    "py-1",
                  )}
                >
                  {emptyOptionLabel ? (
                    <button
                      type="button"
                      role="option"
                      aria-selected={value === ""}
                      onClick={() => {
                        onChange("");
                        setOpen(false);
                        buttonRef.current?.focus();
                      }}
                      className={cn(
                        "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px]",
                        "hover:bg-app-hover focus:bg-app-hover focus:outline-none",
                        value === "" && "bg-app-primary-bg",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-app-text">
                        {emptyOptionLabel}
                      </span>
                      {value === "" ? (
                        <Check
                          className="h-3 w-3 shrink-0 text-app-primary"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  ) : null}
                  {groups.length === 0 ? (
                    <div className="px-2.5 py-1.5 text-[12px] text-app-text-muted">
                      No Agents available
                    </div>
                  ) : (
                    groups.map((group) => (
                      <div key={group.id}>
                        <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted">
                          {group.label}
                        </div>
                        {group.agents.map((agent) => {
                          const isSelected = agent.id === value;
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              role="option"
                              aria-selected={isSelected}
                              disabled={!agent.available}
                              onClick={() => {
                                onChange(agent.id);
                                setOpen(false);
                                buttonRef.current?.focus();
                              }}
                              className={cn(
                                "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px]",
                                "hover:bg-app-hover focus:bg-app-hover focus:outline-none",
                                isSelected && "bg-app-primary-bg",
                                !agent.available &&
                                  "cursor-not-allowed opacity-50",
                              )}
                              title={
                                agent.available
                                  ? agent.displayName
                                  : `${agent.displayName} (unavailable in this environment)`
                              }
                            >
                              <AgentBaseBadge base={agent.provider} />
                              <span className="min-w-0 flex-1 truncate text-app-text">
                                {agent.displayName}
                              </span>
                              {!agent.available ? (
                                <span className="shrink-0 text-[11px] text-app-text-muted">
                                  Unavailable
                                </span>
                              ) : isSelected ? (
                                <Check
                                  className="h-3 w-3 shrink-0 text-app-primary"
                                  aria-hidden="true"
                                />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ))
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  );
}

function AgentBaseBadge({
  base,
  className,
}: {
  base?: string;
  className?: string;
}) {
  const color = baseColor(base);
  return (
    <span
      className={cn(
        "inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px]",
        color.block,
        className,
      )}
      aria-hidden="true"
      title={color.label}
    />
  );
}
