/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders a clean placeholder for Console modules not yet wired to live data.
*/
import { ModulePage } from "@/components/console/ModulePage";
import { EmptyState, type Crumb } from "@/components/ui";

export function ModulePlaceholder({
  title,
  description,
  breadcrumbs,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  description: string;
  breadcrumbs: Crumb[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <ModulePage title={title} description={description} breadcrumbs={breadcrumbs}>
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        icon={
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        }
      />
    </ModulePage>
  );
}
