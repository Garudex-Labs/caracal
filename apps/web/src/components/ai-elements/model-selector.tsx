/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the ModelSelector component family ported to the Caracal design system.
*/
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cx } from "@/lib/cx";

export interface ModelOption {
  id: string;
  name: string;
  model: string;
  available: boolean;
}

type ModelSelectorSchema = {
  open: boolean;
  setOpen: (open: boolean) => void;
  query: string;
  setQuery: (value: string) => void;
};

const ModelSelectorContext = createContext<ModelSelectorSchema | null>(null);

const useModelSelector = () => {
  const ctx = useContext(ModelSelectorContext);
  if (!ctx) throw new Error("ModelSelector components must be used within ModelSelector");
  return ctx;
};

export type ModelSelectorProps = Omit<ComponentProps<"div">, "children"> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
};

export const ModelSelector = ({
  open: controlledOpen,
  onOpenChange,
  className,
  children,
  ...props
}: ModelSelectorProps) => {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlledOpen ?? uncontrolled;
  const setOpen = (next: boolean) => {
    setUncontrolled(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <ModelSelectorContext.Provider value={{ open, setOpen, query, setQuery }}>
      <div ref={ref} className={cx("relative inline-flex", className)} {...props}>
        {children}
      </div>
    </ModelSelectorContext.Provider>
  );
};

export type ModelSelectorTriggerProps = ComponentProps<"button">;

export const ModelSelectorTrigger = ({
  children,
  className,
  ...props
}: ModelSelectorTriggerProps) => {
  const { open, setOpen } = useModelSelector();
  return (
    <button
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronGlyph className="h-3 w-3" />
    </button>
  );
};

export const ModelSelectorName = ({ children, className }: ComponentProps<"span">) => (
  <span className={cx("truncate", className)}>{children}</span>
);

export type ModelSelectorContentProps = ComponentProps<"div"> & {
  placement?: "top" | "bottom";
};

export const ModelSelectorContent = ({
  children,
  className,
  placement = "top",
  ...props
}: ModelSelectorContentProps) => {
  const { open } = useModelSelector();
  if (!open) return null;
  return (
    <div
      role="listbox"
      className={cx(
        "animate-fade-in absolute left-0 z-50 w-64 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg",
        placement === "top" ? "bottom-full mb-2" : "top-full mt-2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export const ModelSelectorInput = ({
  placeholder = "Search models…",
}: {
  placeholder?: string;
}) => {
  const { query, setQuery } = useModelSelector();
  return (
    <div className="border-b border-border p-2">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label="Search models"
        className="h-8 w-full bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
    </div>
  );
};

export const ModelSelectorList = ({ children }: { children: ReactNode }) => (
  <div className="scrollbar-thin max-h-64 overflow-y-auto p-1">{children}</div>
);

export const ModelSelectorEmpty = ({ children }: { children: ReactNode }) => (
  <p className="px-2 py-3 text-center text-xs text-muted-foreground">{children}</p>
);

export type ModelSelectorItemProps = {
  value: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
};

export const ModelSelectorItem = ({
  value,
  onSelect,
  disabled,
  children,
}: ModelSelectorItemProps) => {
  const { query } = useModelSelector();
  const haystack = `${value}`.toLowerCase();
  if (query.trim() && !haystack.includes(query.trim().toLowerCase())) return null;
  return (
    <button
      type="button"
      role="option"
      disabled={disabled}
      onClick={() => onSelect(value)}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
};

export const ModelSelectorCheck = ({ active }: { active: boolean }) =>
  active ? (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ml-auto h-4 w-4 text-accent-purple"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ) : (
    <span className="ml-auto h-4 w-4" />
  );

function ChevronGlyph({ className }: { className?: string }) {
  return (
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
}
