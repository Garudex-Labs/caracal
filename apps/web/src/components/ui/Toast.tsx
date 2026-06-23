/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the toast provider and viewport for transient notifications.
*/
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "@/lib/cx";
import { ToastContext, type ToastMessage } from "./toastContext";

function ToastIcon({ tone }: { tone: ToastMessage["tone"] }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
  } as const;
  if (tone === "success")
    return (
      <svg {...common}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  if (tone === "error")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function ToastRow({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  const tones = {
    success: "text-emerald-600 dark:text-emerald-400",
    error: "text-destructive",
    info: "text-foreground",
  } as const;
  return (
    <div className="animate-toast-in flex w-80 items-start gap-3 rounded-md border border-border bg-card px-4 py-3 shadow-lg">
      <span className={cx("mt-0.5 shrink-0", tones[toast.tone])}>
        <ToastIcon tone={toast.tone} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{toast.description}</p>
        ) : null}
      </div>
      <button
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 6l12 12M6 18 18 6" />
        </svg>
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast: Omit<ToastMessage, "id">) => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list, { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), 4500),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex flex-col gap-2">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastRow toast={toast} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
