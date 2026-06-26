/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the standard header frame for Console module pages.
*/
import type { ReactNode } from "react";

import { Breadcrumbs, Tooltip, type Crumb } from "@/components/ui";
import { cx } from "@/lib/cx";

export function ModulePage({
  title,
  description,
  actions,
  titleAccessory,
  breadcrumbs,
  children,
  fill = false,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  titleAccessory?: ReactNode;
  breadcrumbs?: Crumb[];
  children: ReactNode;
  fill?: boolean;
}) {
  const crumbs: Crumb[] =
    breadcrumbs && breadcrumbs.length > 0
      ? breadcrumbs
      : [{ label: "Console", to: "/app" }, { label: title }];

  return (
    <div className={cx("animate-fade-in", fill && "flex min-h-0 flex-1 flex-col")}>
      <div className={cx("mb-6 flex items-center justify-between gap-3", fill && "flex-shrink-0")}>
        <div className="flex min-w-0 items-center gap-2">
          <Breadcrumbs items={crumbs} />
          {titleAccessory}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {actions}
          {description ? (
            <Tooltip label={description} side="bottom" align="end">
              <button
                type="button"
                aria-label={`About ${title}`}
                className="inline-grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>
      {fill ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : children}
    </div>
  );
}
