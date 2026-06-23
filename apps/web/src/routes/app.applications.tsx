/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Applications route.
*/
import { createFileRoute } from "@tanstack/react-router";

import { ModulePage } from "@/components/console/ModulePage";
import { Badge, Card, SectionTitle } from "@/components/ui/Primitives";

export const Route = createFileRoute("/app/applications")({
  component: Page,
});

function Page() {
  return (
    <ModulePage
      title="Applications"
      description="Manage agent applications in the active zone."
      actions={<Badge tone="muted">UI in progress</Badge>}
    >
      <Card>
        <SectionTitle>Planned capabilities</SectionTitle>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-foreground">
          <li className="flex items-start gap-2">
            <span className="mt-1 text-muted-foreground">·</span>
            <span>Create, patch, and delete applications</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 text-muted-foreground">·</span>
            <span>Issue and rotate client credentials</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 text-muted-foreground">·</span>
            <span>Enable dynamic client registration (DCR)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 text-muted-foreground">·</span>
            <span>Inspect application identity and traits</span>
          </li>{" "}
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          These mirror the terminal Console and connect to the Control API in a later step.
        </p>
      </Card>
    </ModulePage>
  );
}
