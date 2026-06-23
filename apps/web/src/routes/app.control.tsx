/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Control API route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Badge, Card, EmptyState, SectionTitle, Tabs } from "@/components/ui";

export const Route = createFileRoute("/app/control")({
  component: ControlAPIPage,
});

function ControlAPIPage() {
  const [tab, setTab] = useState("overview");
  return (
    <ModulePage
      title="Control API"
      description="Manage the optional Control automation service."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Control API" }]}
      actions={<Badge tone="muted">UI in progress</Badge>}
    >
      <div className="mb-5">
        <Tabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "activity", label: "Activity" },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      {tab === "overview" ? (
        <Card>
          <SectionTitle>Planned capabilities</SectionTitle>
          <ul className="mt-3 flex flex-col gap-2.5">
            <li className="flex items-start gap-2 text-sm text-foreground">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>Enable or disable the Control endpoint</span>
            </li>
            <li className="flex items-start gap-2 text-sm text-foreground">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>Create, rotate, and revoke Control keys</span>
            </li>
            <li className="flex items-start gap-2 text-sm text-foreground">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>Issue short-lived invocation tokens</span>
            </li>
            <li className="flex items-start gap-2 text-sm text-foreground">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>Scope keys with control permissions</span>
            </li>{" "}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            These mirror the terminal Console and connect to the Control API in a later step.
          </p>
        </Card>
      ) : (
        <EmptyState
          title="No activity yet"
          description="Activity for this module appears here once it is connected to the Control API."
        />
      )}
    </ModulePage>
  );
}
