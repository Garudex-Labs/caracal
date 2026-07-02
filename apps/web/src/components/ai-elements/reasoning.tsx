/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the Reasoning disclosure component family ported to the Caracal design system.
*/
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cx } from "@/lib/cx";

import { Response } from "./response";

const MS_IN_S = 1000;
const AUTO_CLOSE_DELAY = 1000;

type ReasoningSchema = {
  isStreaming: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  duration: number;
};

const ReasoningContext = createContext<ReasoningSchema | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<"div"> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Seconds the model spent reasoning, supplied when the duration is known up front
  // (a persisted turn). When omitted it is measured from the streaming window.
  duration?: number;
  children: ReactNode;
};

// Root provider and disclosure controller. It opens itself while the model is
// streaming its chain of thought and collapses shortly after streaming ends, unless
// the caller controls the open state or pins it open. With no third-party collapsible
// it carries no UI dependency, matching the rest of the ported element family.
export const Reasoning = ({
  isStreaming = false,
  open,
  defaultOpen = false,
  onOpenChange,
  duration: durationProp,
  className,
  children,
  ...props
}: ReasoningProps) => {
  const [openState, setOpenState] = useState(defaultOpen);
  const [duration, setDuration] = useState(durationProp ?? 0);
  const [autoOpened, setAutoOpened] = useState(false);
  const startedAt = useRef<number | null>(null);

  const controlled = open !== undefined;
  const isOpen = controlled ? open : openState;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setOpenState(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  // Measure how long the model reasoned across the streaming window, so the trigger
  // can report a real elapsed time rather than an estimate.
  useEffect(() => {
    if (durationProp !== undefined) return;
    if (isStreaming) {
      if (startedAt.current === null) startedAt.current = Date.now();
      return;
    }
    if (startedAt.current !== null) {
      setDuration(Math.round((Date.now() - startedAt.current) / MS_IN_S));
      startedAt.current = null;
    }
  }, [isStreaming, durationProp]);

  // Open while streaming begins and collapse once it ends, but only when this
  // component opened itself: a caller's explicit open state is never overridden.
  useEffect(() => {
    if (isStreaming && !isOpen && !autoOpened) {
      setOpen(true);
      setAutoOpened(true);
      return;
    }
    if (!isStreaming && isOpen && autoOpened) {
      const timer = setTimeout(() => {
        setOpen(false);
        setAutoOpened(false);
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, isOpen, autoOpened, setOpen]);

  return (
    <ReasoningContext.Provider value={{ isStreaming, open: isOpen, setOpen, duration }}>
      <div className={cx("flex flex-col gap-1.5", className)} {...props}>
        {children}
      </div>
    </ReasoningContext.Provider>
  );
};

const ChevronGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path
      d="m9 6 6 6-6 6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const BrainGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path
      d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6A3 3 0 0 0 6 17a3 3 0 0 0 3 3V3Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.6A3 3 0 0 1 18 17a3 3 0 0 1-3 3V3Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

export type ReasoningTriggerProps = ComponentProps<"button">;

export const ReasoningTrigger = ({ children, className, ...props }: ReasoningTriggerProps) => {
  const { isStreaming, open, setOpen, duration } = useReasoning();
  const label = isStreaming
    ? "Thinking…"
    : duration > 0
      ? `Thought for ${duration} second${duration === 1 ? "" : "s"}`
      : "Reasoning";

  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className={cx(
        "inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <BrainGlyph className={cx("h-3.5 w-3.5", isStreaming && "animate-pulse")} />
          <span className="font-medium">{label}</span>
          <ChevronGlyph className={cx("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </>
      )}
    </button>
  );
};

export type ReasoningContentProps = Omit<ComponentProps<"div">, "children"> & {
  children: ReactNode;
};
export const ReasoningContent = ({ children, className, ...props }: ReasoningContentProps) => {
  const { open } = useReasoning();
  if (!open) return null;
  return (
    <div
      className={cx(
        "animate-fade-in border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground",
        className,
      )}
      {...props}
    >
      <Response className="text-xs text-muted-foreground">
        {typeof children === "string" ? children : ""}
      </Response>
    </div>
  );
};
