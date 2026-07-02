/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the Tool call disclosure component family ported to the Caracal design system.
*/
import {
  createContext,
  Fragment,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cx } from "@/lib/cx";

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

const CheckboxGlyph = ({ state, className }: { state: ToolState; className?: string }) => {
  const done = state === "output-available";
  const failed = state === "output-error" || state === "output-denied";
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="2" />
      {done ? (
        <path
          d="M7.5 12.4l2.8 2.8 6.2-6.6"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {failed ? (
        <path
          d="M8.5 8.5l7 7M15.5 8.5l-7 7"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
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

const CheckGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path
      d="M5 12l5 5 9-10"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CrossGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

const ClockGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
    <path d="M12 8v4.5l3 1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const SpinnerGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={cx("animate-spin", className)} aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

const STATUS_META: Record<
  ToolState,
  { label: string; badge: string; icon: ReactNode; mark: string }
> = {
  "input-streaming": {
    label: "Pending",
    badge: "border-border bg-muted text-muted-foreground",
    icon: <ClockGlyph className="h-2.5 w-2.5" />,
    mark: "text-muted-foreground/60",
  },
  "input-available": {
    label: "Running",
    badge: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    icon: <SpinnerGlyph className="h-2.5 w-2.5" />,
    mark: "text-muted-foreground/60",
  },
  "approval-requested": {
    label: "Awaiting approval",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: <ClockGlyph className="h-2.5 w-2.5" />,
    mark: "text-amber-600 dark:text-amber-400",
  },
  "approval-responded": {
    label: "Responded",
    badge: "border-border bg-muted text-muted-foreground",
    icon: <CheckGlyph className="h-2.5 w-2.5" />,
    mark: "text-muted-foreground/60",
  },
  "output-available": {
    label: "Completed",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: <CheckGlyph className="h-2.5 w-2.5" />,
    mark: "text-emerald-600 dark:text-emerald-400",
  },
  "output-error": {
    label: "Error",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
    icon: <CrossGlyph className="h-2.5 w-2.5" />,
    mark: "text-destructive",
  },
  "output-denied": {
    label: "Denied",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
    icon: <CrossGlyph className="h-2.5 w-2.5" />,
    mark: "text-destructive",
  },
};

type ToolSchema = {
  open: boolean;
  setOpen: (open: boolean) => void;
  contentId: string;
};

const ToolContext = createContext<ToolSchema | null>(null);

const useTool = () => {
  const context = useContext(ToolContext);
  if (!context) {
    throw new Error("Tool components must be used within Tool");
  }
  return context;
};

export type ToolProps = ComponentProps<"div"> & {
  defaultOpen?: boolean;
};

// Root collapsible container for a single tool call. It owns its open state so the
// component carries no external UI dependency, matching the rest of the port.
export const Tool = ({ defaultOpen = false, className, children, ...props }: ToolProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <ToolContext.Provider value={{ open, setOpen, contentId }}>
      <div className={cx("flex flex-col", className)} {...props}>
        {children}
      </div>
    </ToolContext.Provider>
  );
};

export type ToolHeaderProps = Omit<ComponentProps<"button">, "type" | "title"> & {
  type: string;
  title?: ReactNode;
  state: ToolState;
  // Optional metadata rendered between the title and the status pill, such as a per-step risk
  // signal. It sits in the header flow without affecting the title's truncation.
  accessory?: ReactNode;
};

// The clickable header: the tool's name, a status pill derived from its lifecycle
// state, and a disclosure chevron. The display name falls back to the `tool-` part
// type with its prefix stripped.
export const ToolHeader = ({
  type,
  title,
  state,
  accessory,
  className,
  ...props
}: ToolHeaderProps) => {
  const { open, setOpen, contentId } = useTool();
  const meta = STATUS_META[state];
  const name = title ?? type.replace(/^tool-/, "");

  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      onClick={() => setOpen(!open)}
      className={cx(
        "group flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      {...props}
    >
      <CheckboxGlyph state={state} className={cx("h-4 w-4 shrink-0", meta.mark)} />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
      {accessory}
      <span
        className={cx(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          meta.badge,
        )}
      >
        {meta.icon}
        {meta.label}
      </span>
      <ChevronGlyph
        className={cx(
          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-90",
        )}
      />
    </button>
  );
};

export type ToolContentProps = ComponentProps<"div">;

export const ToolContent = ({ children, className, ...props }: ToolContentProps) => {
  const { open, contentId } = useTool();
  if (!open) return null;
  return (
    <div
      id={contentId}
      className={cx(
        "animate-fade-in flex flex-col gap-3 border-t border-border px-3.5 py-3",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export type ToolInputProps = Omit<ComponentProps<"div">, "input"> & {
  input: unknown;
};

// Turns a parameter value into a single readable line: strings and scalars as-is, arrays joined,
// and any nested object as compact JSON so the definition list stays one row per parameter.
function formatValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.length > 0 ? value : "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)))
      .join(", ");
  }
  return JSON.stringify(value);
}

// Renders the validated parameters the tool will run with. A plain object is shown as a labelled
// key/value list so the change reads clearly - the parameter name humanized and its value beside
// it - rather than as raw JSON. An empty argument set is stated plainly, and any non-object value
// falls back to formatted JSON.
export const ToolInput = ({ input, className, ...props }: ToolInputProps) => {
  const isObject = input != null && typeof input === "object" && !Array.isArray(input);
  const entries = isObject ? Object.entries(input as Record<string, unknown>) : [];
  const empty = input == null || (isObject && entries.length === 0);

  return (
    <div className={cx("flex flex-col gap-1.5", className)} {...props}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Parameters
      </span>
      {empty ? (
        <span className="text-xs text-muted-foreground">No parameters</span>
      ) : isObject ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 rounded-md border border-border bg-muted/40 p-2.5 text-[11px] leading-relaxed">
          {entries.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-medium text-muted-foreground">{key.replace(/_/g, " ")}</dt>
              <dd className="min-w-0 break-words font-mono text-foreground">
                {formatValue(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
};

export type ToolOutputProps = Omit<ComponentProps<"div">, "output"> & {
  output?: ReactNode;
  errorText?: string;
};

export const ToolOutput = ({ output, errorText, className, ...props }: ToolOutputProps) => {
  if (!output && !errorText) return null;
  return (
    <div className={cx("flex flex-col gap-1.5", className)} {...props}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {errorText ? "Error" : "Result"}
      </span>
      <div
        className={cx(
          "rounded-md border p-2 text-[11px] leading-relaxed",
          errorText
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-border bg-muted/40 text-foreground",
        )}
      >
        {errorText ?? output}
      </div>
    </div>
  );
};
