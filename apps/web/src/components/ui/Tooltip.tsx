/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides an accessible hover and focus tooltip.
*/
import { useState, type ReactNode } from "react";

import { cx } from "@/lib/cx";

export function Tooltip({
  label,
  align = "center",
  children,
}: {
  label: string;
  align?: "center" | "start";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          className={cx(
            "animate-fade-in pointer-events-none absolute bottom-full z-50 mb-2 block w-80 max-w-[calc(100vw-2rem)] whitespace-normal rounded-md border border-border bg-popover px-3 py-2 text-left text-xs font-normal leading-5 text-popover-foreground shadow-lg",
            align === "start" ? "left-0" : "left-1/2 -translate-x-1/2",
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
