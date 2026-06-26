/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the Agent configuration component family ported to the Caracal design system.
*/
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cx } from "@/lib/cx";

const BotGlyph = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="4" y="8" width="16" height="11" rx="2" />
    <path d="M12 8V4M9 4h6M8.5 13h.01M15.5 13h.01M9 16h6" />
  </svg>
);

const ChevronDownGlyph = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

// Root card holding the agent's identity, instructions, tools, and output contract.
export type AgentProps = ComponentProps<"div">;

export const Agent = ({ className, ...props }: AgentProps) => (
  <div
    className={cx(
      "flex flex-col rounded-xl border border-border bg-card text-foreground",
      className,
    )}
    {...props}
  />
);

// Identity row: a model badge sits beside the agent name.
export type AgentHeaderProps = Omit<ComponentProps<"div">, "children"> & {
  name: string;
  model?: string;
};

export const AgentHeader = ({ name, model, className, ...props }: AgentHeaderProps) => (
  <div
    className={cx(
      "flex items-center justify-between gap-3 border-b border-border px-4 py-3",
      className,
    )}
    {...props}
  >
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-muted text-foreground">
        <BotGlyph className="h-4 w-4" />
      </span>
      <span className="truncate text-sm font-semibold text-foreground">{name}</span>
    </div>
    {model ? (
      <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
        {model}
      </span>
    ) : null}
  </div>
);

export type AgentContentProps = ComponentProps<"div">;

export const AgentContent = ({ className, ...props }: AgentContentProps) => (
  <div className={cx("flex flex-col gap-4 px-4 py-4", className)} {...props} />
);

// System instructions that describe the agent's role and operating boundaries.
export type AgentInstructionsProps = Omit<ComponentProps<"div">, "children"> & {
  children: string;
};

export const AgentInstructions = ({ children, className, ...props }: AgentInstructionsProps) => (
  <div className={cx("flex flex-col gap-1.5", className)} {...props}>
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      Instructions
    </span>
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{children}</p>
  </div>
);

type AgentToolsSchema = {
  open: Set<string>;
  toggle: (value: string) => void;
};

const AgentToolsContext = createContext<AgentToolsSchema | null>(null);

const useAgentTools = () => {
  const context = useContext(AgentToolsContext);
  if (!context) {
    throw new Error("AgentTool must be used within AgentTools");
  }
  return context;
};

// Accordion of the agent's available tools. With `type="single"` opening one tool
// closes the others; `type="multiple"` lets several stay expanded at once.
export type AgentToolsProps = Omit<ComponentProps<"div">, "type"> & {
  type?: "single" | "multiple";
};

export const AgentTools = ({
  type = "multiple",
  className,
  children,
  ...props
}: AgentToolsProps) => {
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const toggle = useCallback(
    (value: string) => {
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(value)) {
          next.delete(value);
          return next;
        }
        if (type === "single") next.clear();
        next.add(value);
        return next;
      });
    },
    [type],
  );

  return (
    <AgentToolsContext.Provider value={{ open, toggle }}>
      <div className={cx("flex flex-col gap-1.5", className)} {...props}>
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Tools
        </span>
        <div className="overflow-hidden rounded-lg border border-border">{children}</div>
      </div>
    </AgentToolsContext.Provider>
  );
};

// Description and optional input schema of a single tool the agent can call.
export type AgentToolSpec = {
  description?: string;
  inputSchema?: string;
};

export type AgentToolProps = Omit<ComponentProps<"div">, "children"> & {
  value: string;
  name?: string;
  tool: AgentToolSpec;
};

export const AgentTool = ({ value, name, tool, className, ...props }: AgentToolProps) => {
  const { open, toggle } = useAgentTools();
  const contentId = useId();
  const expanded = open.has(value);

  return (
    <div className={cx("border-b border-border last:border-b-0", className)} {...props}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => toggle(value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-xs font-medium text-foreground">
            {name ?? value}
          </span>
          {tool.description ? (
            <span className="truncate text-xs text-muted-foreground">{tool.description}</span>
          ) : null}
        </span>
        <ChevronDownGlyph
          className={cx(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div id={contentId} className="animate-fade-in flex flex-col gap-2 px-3 pb-3">
          {tool.description ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{tool.description}</p>
          ) : null}
          {tool.inputSchema ? (
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground">
              {tool.inputSchema}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// The structured output contract the agent returns, shown as a schema block.
export type AgentOutputProps = Omit<ComponentProps<"div">, "children"> & {
  schema: string;
};

export const AgentOutput = ({ schema, className, ...props }: AgentOutputProps) => (
  <div className={cx("flex flex-col gap-1.5", className)} {...props}>
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      Output
    </span>
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground">
      {schema}
    </pre>
  </div>
);
