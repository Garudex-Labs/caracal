/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the navbar language selector; Community Edition currently ships English only.
*/
import { useEffect, useRef, useState } from "react";

import { cx } from "@/lib/cx";

interface Language {
  code: string;
  label: string;
}

// Community Edition ships English only today; additional locales are reserved
// for a future translation pass.
const LANGUAGES: Language[] = [{ code: "en", label: "English" }];

export function LanguageMenu() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("en");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = LANGUAGES.find((l) => l.code === active) ?? LANGUAGES[0];

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Change language"
        className={cx(
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
          open && "text-foreground",
        )}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
        <span className="hidden text-xs font-medium uppercase tracking-wide sm:inline">
          {current.code}
        </span>
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Language
          </div>
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => {
                setActive(lang.code);
                setOpen(false);
              }}
              className={cx(
                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                lang.code === active && "bg-accent",
              )}
            >
              <span className="text-foreground">{lang.label}</span>
              {lang.code === active ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="text-foreground"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : null}
            </button>
          ))}
          <div className="mt-1 border-t border-border px-2 pb-0.5 pt-1.5 text-[10px] text-muted-foreground">
            More languages coming soon.
          </div>
        </div>
      ) : null}
    </div>
  );
}
