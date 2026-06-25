/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides an advanced-options section that opens as an animated in-modal sheet.
*/
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "@/lib/cx";
import { IconButton } from "./Primitives";

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function ChevronLeft({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

// A tidy "advanced options" entry. Clicking it slides a secondary panel in over the parent
// modal — a new internal window showing only the advanced fields — with a back affordance to
// return. When it cannot find a modal surface (used outside a modal) it falls back to a plain
// inline expand so it is always usable.
export function Disclosure({
  title,
  description,
  count,
  hasError,
  children,
}: {
  title: string;
  description?: string;
  count?: number;
  hasError?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A hidden advanced field that fails validation must not stay buried, so reveal the sheet
  // automatically when an error appears inside it.
  useEffect(() => {
    if (hasError) {
      setSurface(triggerRef.current?.closest<HTMLElement>("[data-modal-surface]") ?? null);
      setClosing(false);
      setOpen(true);
    }
  }, [hasError]);

  function openSheet() {
    setSurface(triggerRef.current?.closest<HTMLElement>("[data-modal-surface]") ?? null);
    setClosing(false);
    setOpen(true);
  }

  function closeSheet() {
    if (hasError) return; // keep the operator on the unresolved error
    setClosing(true);
  }

  // Close the sheet on Escape without also dismissing the parent modal.
  useEffect(() => {
    if (!open || closing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeSheet();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing, hasError]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={openSheet}
      aria-haspopup="dialog"
      aria-expanded={open}
      className="flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {typeof count === "number" && count > 0 ? (
            <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
          ) : null}
          {hasError ? (
            <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-destructive" />
          ) : null}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <ChevronRight className="flex-shrink-0 text-muted-foreground" />
    </button>
  );

  const sheet =
    open && surface
      ? createPortal(
          <div
            role="dialog"
            aria-label={title}
            onAnimationEnd={() => {
              if (closing) {
                setClosing(false);
                setOpen(false);
              }
            }}
            className={cx(
              "absolute inset-0 z-20 flex flex-col bg-card",
              closing ? "animate-sheet-out" : "animate-sheet-in",
            )}
          >
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-3">
              <IconButton label="Back" onClick={closeSheet}>
                <ChevronLeft />
              </IconButton>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
                {description ? (
                  <p className="truncate text-xs text-muted-foreground">{description}</p>
                ) : null}
              </div>
            </div>
            <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              {children}
            </div>
            <div className="flex flex-shrink-0 justify-end border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={closeSheet}
                className="inline-flex h-9 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                Done
              </button>
            </div>
          </div>,
          surface,
        )
      : null;

  // Fallback: no modal surface (rendered outside a modal). Expand inline instead.
  const inline =
    open && !surface ? (
      <div className="mt-2 flex flex-col gap-4 rounded-lg border border-border p-3">{children}</div>
    ) : null;

  return (
    <>
      {trigger}
      {inline}
      {sheet}
    </>
  );
}
