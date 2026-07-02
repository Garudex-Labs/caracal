/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders streamed Operator markdown with syntax highlighting, tables, task lists, and hardened links.
*/
import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";

import { cx } from "@/lib/cx";

import "streamdown/styles.css";

export type ResponseProps = ComponentProps<typeof Streamdown>;

// Wraps Streamdown so every Operator answer renders as rich markdown: bold, italic, headings,
// ordered and unordered lists, task lists, blockquotes, tables, horizontal rules, inline code,
// and fenced code blocks with highlighting, copy controls, and horizontal scrolling. Incomplete
// markdown is completed while a response streams so partial tokens never break the layout. The
// memo compares children so a steady stream only re-renders when the text actually grows.
export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      className={cx(
        "size-full min-w-0 wrap-break-word text-sm leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_a]:wrap-break-word [&_a]:font-medium [&_a]:text-accent-purple [&_a]:underline [&_a]:decoration-accent-purple/40 [&_a]:underline-offset-2 [&_a]:transition-colors hover:[&_a]:decoration-accent-purple",
        "[&_code]:wrap-break-word [&_pre]:max-w-full [&_pre]:overflow-x-auto",
        "[&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-lg",
        "[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto",
        className,
      )}
      {...props}
    />
  ),
  (prev, next) => prev.children === next.children,
);

Response.displayName = "Response";
