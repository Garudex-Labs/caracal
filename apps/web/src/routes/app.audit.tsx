/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Audit route.
*/
import { createFileRoute } from "@tanstack/react-router";

import { ModulePlaceholder } from "@/components/console/ModulePlaceholder";

export const Route = createFileRoute("/app/audit")({
  component: AuditPage,
});

function AuditPage() {
  return (
    <ModulePlaceholder
      title="Audit"
      description="Every authority decision, with full request context."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
      emptyTitle="No audit events yet"
      emptyDescription="Decisions are recorded here as agents request and exercise authority."
    />
  );
}
