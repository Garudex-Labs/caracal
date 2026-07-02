/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the shared modal and drawer overlays for the Console UI.
*/
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "@/lib/cx";
import { IconButton } from "./Primitives";

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M6 6l12 12M6 18 18 6" />
    </svg>
  );
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:pt-[8vh]">
      <div
        className="animate-overlay-in fixed inset-0 bg-overlay/40 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-modal-surface=""
        className="animate-pop-in relative z-10 flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl sm:max-h-[84dvh]"
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <h2 className="min-w-0 break-words text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose} className="flex-shrink-0">
            <CloseIcon />
          </IconButton>
        </div>
        {description || children ? (
          <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
            {description ? (
              <p className="break-words text-xs leading-5 text-muted-foreground">{description}</p>
            ) : null}
            {children}
          </div>
        ) : null}
        {footer ? (
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  width = "max-w-md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="animate-overlay-in absolute inset-0 bg-overlay/40 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "animate-slide-in-right absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-card shadow-xl",
          width,
        )}
      >
        <div className="flex flex-shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          {icon ? <div className="mt-0.5 flex-shrink-0">{icon}</div> : null}
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-sm font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose} className="flex-shrink-0">
            <CloseIcon />
          </IconButton>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer ? (
          <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
