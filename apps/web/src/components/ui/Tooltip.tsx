/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides an accessible hover and focus tooltip.
*/
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cx } from "@/lib/cx";

const TOOLTIP_WIDTH = 320;
const VIEWPORT_MARGIN = 16;

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
  // buttons, selectable identifiers) can be reached; a short grace timer covers the pointer
  // crossing from the trigger to the card.
  interactive?: boolean;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number; side: "top" | "bottom" } | null>(
    null,
  );
  const anchorRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const id = useId();

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // The card renders in a body portal with a fixed, viewport-clamped position, so a
  // scrolling drawer or an overflow-hidden card can never clip it mid-sentence.
  const show = () => {
    window.clearTimeout(closeTimer.current);
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(TOOLTIP_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    let left =
      align === "start"
        ? rect.left
        : align === "end"
          ? rect.right - width
          : rect.left + rect.width / 2 - width / 2;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN));
    const resolvedSide = side === "top" && rect.top < 96 ? "bottom" : side;
    setPos({ left, top: resolvedSide === "top" ? rect.top : rect.bottom, side: resolvedSide });
  };
  const hide = () => {
    if (!interactive) {
      setPos(null);
      return;
    }
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setPos(null), 120);
  };
  const cancelHide = () => window.clearTimeout(closeTimer.current);

  const open = pos !== null;
  // Associate the tooltip text with its trigger so assistive technology announces the hint
  // when the control receives focus, matching the accessible InfoHint pattern.
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": open ? id : undefined,
      })
    : children;
  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {trigger}
      {pos
        ? createPortal(
            <span
              role="tooltip"
              id={id}
              style={{
                left: pos.left,
                top: pos.top,
                width: Math.min(TOOLTIP_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2),
              }}
              className={cx(
                "animate-fade-in fixed z-[60] block",
                interactive ? "pointer-events-auto" : "pointer-events-none",
                pos.side === "top" ? "-translate-y-full pb-2" : "pt-2",
              )}
              onMouseEnter={interactive ? cancelHide : undefined}
              onMouseLeave={interactive ? hide : undefined}
            >
              <span className="block whitespace-normal rounded-md border border-border bg-popover px-3 py-2 text-left text-xs font-normal leading-5 text-popover-foreground shadow-lg">
                {label}
              </span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
