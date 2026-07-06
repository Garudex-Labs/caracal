/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the shared presentational primitives for the Console UI.
*/
import { lazy, Suspense, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { cx } from "@/lib/cx";
import { InfoHint } from "./InfoHint";
import { useViewOnly, READ_ONLY_BLOCK_MESSAGE } from "./ViewOnly";

// The dithering backdrop pulls in a WebGL shader library, so it is code-split and only
// fetched when an empty state actually renders, keeping the shared primitives chunk lean.
const DitherBackdrop = lazy(() =>
  import("./neon-dither").then((m) => ({ default: m.DitherBackdrop })),
);

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx("animate-spin", className)}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  mutating = false,
  className,
  children,
  disabled,
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  // Marks the button as a state-changing action. In a read-only surface (e.g. the system zone
  // shown for transparency) every mutating control is disabled, so a view-only page cannot trigger
  // a change the control plane would refuse anyway.
  mutating?: boolean;
}) {
  const { readOnly, reason } = useViewOnly();
  const blocked = mutating && readOnly;
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
    secondary:
      "border border-border bg-background text-foreground hover:bg-accent active:bg-accent/70",
    ghost: "text-foreground hover:bg-accent active:bg-accent/70",
    danger:
      "border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15 active:bg-destructive/20",
  };
  const sizes: Record<ButtonSize, string> = {
    sm: "h-8 gap-1.5 px-3 text-xs",
    md: "h-9 gap-2 px-4 text-sm",
  };
  return (
    <button
      disabled={disabled || loading || blocked}
      aria-busy={loading || undefined}
      title={blocked ? (reason ?? READ_ONLY_BLOCK_MESSAGE) : title}
      className={cx(
        "inline-flex select-none items-center justify-center rounded-md font-medium outline-none transition-all",
        "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        sizes[size],
        variants[variant],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      className={cx(
        "inline-grid h-8 w-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors",
        "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

const fieldBase =
  "w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50";

// A field label with an optional info tooltip, so every form control can carry consistent
// inline help on its fields.
export function FieldLabel({ label, info }: { label?: string; info?: string }) {
  if (!label) return null;
  return (
    <span className="mb-1.5 flex items-center gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {info ? <InfoHint label={info} /> : null}
    </span>
  );
}

export function Field({
  label,
  info,
  hint,
  error,
  className,
  id,
  prefix,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  info?: string;
  hint?: string;
  error?: string;
  // A locked namespace rendered inside the control, ahead of the editable text. The value the
  // caller manages excludes it, so users type only the part that varies.
  prefix?: string;
}) {
  // On a read-only surface every editable field is disabled, so a view-only page cannot be used
  // to stage a change. Search is a separate control, so inspection stays fully usable.
  const { readOnly } = useViewOnly();
  const disabled = readOnly || props.disabled;
  return (
    <label className="block" htmlFor={id}>
      <FieldLabel label={label} info={info} />
      {prefix ? (
        <span
          className={cx(
            "flex h-9 w-full items-stretch overflow-hidden rounded-md border border-input bg-background text-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25",
            error && "border-destructive focus-within:ring-destructive/25",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <span
            aria-hidden="true"
            className="flex select-none items-center whitespace-nowrap border-r border-input bg-muted/60 px-2.5 font-mono text-xs text-muted-foreground"
          >
            {prefix}
          </span>
          <input
            id={id}
            className={cx(
              "h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed",
              className,
            )}
            {...props}
            disabled={disabled}
          />
        </span>
      ) : (
        <input
          id={id}
          className={cx(
            fieldBase,
            "h-9",
            error && "border-destructive focus:ring-destructive/25",
            className,
          )}
          {...props}
          disabled={disabled}
        />
      )}
      {error ? (
        <span className="mt-1 block text-xs text-destructive">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

export function PasswordField({
  label,
  info,
  id,
  className,
  onRevealChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label?: string;
  info?: string;
  onRevealChange?: (revealed: boolean) => void;
}) {
  const [show, setShow] = useState(false);
  const { readOnly } = useViewOnly();
  function toggle() {
    setShow((value) => {
      const next = !value;
      onRevealChange?.(next);
      return next;
    });
  }
  return (
    <label className="block" htmlFor={id}>
      <FieldLabel label={label} info={info} />
      <div className="relative">
        <input
          id={id}
          type={show ? "text" : "password"}
          className={cx(fieldBase, "h-9 pr-9", className)}
          {...props}
          disabled={readOnly || props.disabled}
        />
        <button
          type="button"
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          onClick={toggle}
          className="absolute right-2 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {show ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.16 3.19M6.6 6.6A18 18 0 0 0 2 12s3 8 10 8a9 9 0 0 0 5.4-1.6" />
              <path d="m2 2 20 20M9.9 9.9a3 3 0 0 0 4.2 4.2" />
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    </label>
  );
}

export function Textarea({
  label,
  info,
  hint,
  className,
  id,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  info?: string;
  hint?: string;
}) {
  const { readOnly } = useViewOnly();
  return (
    <label className="block" htmlFor={id}>
      <FieldLabel label={label} info={info} />
      <textarea
        id={id}
        className={cx(fieldBase, "min-h-20 py-2", className)}
        {...props}
        disabled={readOnly || props.disabled}
      />
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function Select({
  label,
  info,
  className,
  id,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; info?: string }) {
  const { readOnly } = useViewOnly();
  return (
    <label className="block" htmlFor={id}>
      <FieldLabel label={label} info={info} />
      <select
        id={id}
        className={cx(fieldBase, "h-9 cursor-pointer pr-8", className)}
        {...props}
        disabled={readOnly || props.disabled}
      >
        {children}
      </select>
    </label>
  );
}

export function SearchInput({
  className,
  disabled,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cx("relative", disabled && "opacity-50", className)}>
      <svg
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input type="search" disabled={disabled} className={cx(fieldBase, "h-9 pl-8")} {...props} />
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("border border-border bg-card p-5", className)}>{children}</div>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {children}
    </h2>
  );
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "muted";

export function Badge({
  children,
  tone = "neutral",
  dot,
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  title?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: "border-border bg-secondary/60 text-secondary-foreground",
    success: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    warning: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    danger: "border-destructive/25 bg-destructive/10 text-destructive",
    muted: "border-border bg-muted text-muted-foreground",
  };
  const dotTones: Record<BadgeTone, string> = {
    neutral: "bg-muted-foreground",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-destructive",
    muted: "bg-muted-foreground",
  };
  // Colored tones convey live status, so they carry a small status dot by default; neutral
  // and muted badges are plain category labels with no dot. Either can be overridden.
  const showDot = dot ?? (tone === "success" || tone === "warning" || tone === "danger");
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium leading-none",
        tones[tone],
      )}
    >
      {showDot ? (
        <span className={cx("h-1.5 w-1.5 flex-shrink-0 rounded-full", dotTones[tone])} />
      ) : null}
      {children}
    </span>
  );
}

export function LockBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      Enterprise
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-md", className)} />;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  decorated = true,
  bordered = true,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
  decorated?: boolean;
  bordered?: boolean;
}) {
  return (
    <div
      className={cx(
        "relative flex h-full min-h-full flex-1 animate-fade-in flex-col items-center justify-center overflow-hidden px-6 py-16 text-center",
        bordered && "border border-dashed border-border bg-card/40",
      )}
    >
      {decorated ? (
        <Suspense fallback={null}>
          <DitherBackdrop />
        </Suspense>
      ) : null}
      <div className="relative flex flex-col items-center">
        {icon ? <div className="mb-4 text-muted-foreground">{icon}</div> : null}
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{description}</p>
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      )}
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </Card>
  );
}
