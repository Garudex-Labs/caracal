/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the standard header frame for Console module pages.
*/
import type { ReactNode } from "react";

import { Breadcrumbs, Tooltip, type Crumb } from "@/components/ui";

export function ModulePage({
  title,
  description,
  actions,
  breadcrumbs,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
  children: ReactNode;
}) {
  const crumbs: Crumb[] =
    breadcrumbs && breadcrumbs.length > 0
      ? breadcrumbs
      : [{ label: "Console", to: "/app" }, { label: title }];

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center">
          <Breadcrumbs items={crumbs} />
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
      {children}
    </div>
  );
}
