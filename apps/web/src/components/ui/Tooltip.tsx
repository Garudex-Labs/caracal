/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides an accessible hover and focus tooltip.
*/
import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { cx } from "@/lib/cx";

export function Tooltip({
  label,
  align = "center",
  side = "top",
  interactive = false,
  children,
}: {
  label: ReactNode;
  align?: "center" | "start" | "end";
  side?: "top" | "bottom";
  // An interactive tooltip stays open while the pointer is inside it, so its content (copy
  // buttons, selectable identifiers) can be reached; the offset is padding rather than margin
  // so the pointer never crosses a dead gap that would dismiss it.
  interactive?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // Associate the tooltip text with its trigger so assistive technology announces the hint
  // when the control receives focus, matching the accessible InfoHint pattern.
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": open ? id : undefined,
      })
    : children;
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {trigger}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cx(
            "animate-fade-in absolute z-50 block w-80 max-w-[calc(100vw-2rem)]",
            interactive ? "pointer-events-auto" : "pointer-events-none",
            side === "bottom" ? "top-full pt-2" : "bottom-full pb-2",
            align === "start"
              ? "left-0"
              : align === "end"
                ? "right-0"
                : "left-1/2 -translate-x-1/2",
          )}
        >
          <span className="block whitespace-normal rounded-md border border-border bg-popover px-3 py-2 text-left text-xs font-normal leading-5 text-popover-foreground shadow-lg">
            {label}
          </span>
        </span>
      ) : null}
    </span>
  );
}
