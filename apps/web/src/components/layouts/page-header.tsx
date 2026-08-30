// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// The page title, breadcrumbs, and help key are published to the top bar
// (page-chrome); this component only renders a bar when it has actions to show.

import { useEffect, useState } from "react";
import { usePageChrome, type BreadcrumbEntry } from "@/components/layouts/page-chrome";

export type { BreadcrumbEntry };

interface PageHeaderProps {
  title: string;
  breadcrumbs?: BreadcrumbEntry[];
  children?: React.ReactNode;
  actionButtonsLeft?: React.ReactNode;
  actionButtonsRight?: React.ReactNode;
  /** PAGE_DOCS key; renders a contextual help trigger in the top bar. */
  helpKey?: string;
}

export function PageHeader({
  title,
  breadcrumbs,
  children,
  actionButtonsLeft,
  actionButtonsRight,
  helpKey,
}: PageHeaderProps) {
  const { setChrome, clearChrome } = usePageChrome();
  const [owner] = useState(() => Symbol("page-header"));

  const context = (breadcrumbs ?? []).filter(
    (entry, index, entries) =>
      entry.label !== title || index !== entries.length - 1,
  );

  const chromeKey = `${title}|${helpKey ?? ""}|${context.map((c) => `${c.label}:${c.href ?? ""}`).join(">")}`;
  useEffect(() => {
    setChrome({ title, breadcrumbs: context, helpKey }, owner);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chromeKey, setChrome, owner]);
  useEffect(() => () => clearChrome(owner), [clearChrome, owner]);

  const hasActions = !!(actionButtonsLeft || actionButtonsRight || children);
  if (!hasActions) return null;

  return (
    <header className="sticky top-0 z-30 w-full border-b border-border bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/90">
      <h2 className="sr-only">{title}</h2>
      <div className="flex min-h-11 items-center gap-2 px-3 sm:px-4">
        {actionButtonsLeft}
        <div className="ml-auto flex items-center gap-2">
          {actionButtonsRight}
          {children}
        </div>
      </div>
    </header>
  );
}
