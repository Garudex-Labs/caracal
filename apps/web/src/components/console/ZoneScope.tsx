/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file resolves control-plane connection and active-zone context, rendering honest states before zone-scoped screens.
*/
import { appLink } from "@/platform/nav/appLink";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Button, EmptyState, Skeleton, ViewOnlyProvider, type Crumb } from "@/components/ui";
import { useConsoleStatus } from "@/platform/api/hooks";
import { useActiveZone } from "@/platform/api/hooks";
import { isSystemZone } from "@/platform/state/zones";
import type { Zone } from "@/platform/api/types";

function LoadingBody() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-2/3" />
    </div>
  );
}

export function ZoneScopedPage({
  title,
  description,
  breadcrumbs,
  children,
}: {
  title: string;
  description: string;
  breadcrumbs: Crumb[];
  children: (zone: Zone) => ReactNode;
}) {
  const status = useConsoleStatus();
  const { zones, activeZone } = useActiveZone();

  const frame = (body: ReactNode) => (
    <ModulePage title={title} description={description} breadcrumbs={breadcrumbs}>
      {body}
    </ModulePage>
  );

  if (status.isLoading) return frame(<LoadingBody />);

  if (status.isError || !status.data) {
    return frame(
      <EmptyState
        title="Console backend unavailable"
        description="The console service could not be reached. Confirm the authentication service is running, then retry."
        action={<Button onClick={() => status.refetch()}>Retry</Button>}
      />,
    );
  }

  if (!status.data.configured) {
    return frame(
      <EmptyState
        title="Control plane not connected"
        description="No admin credentials were found. Start the local stack with `caracal up` to provision the control plane, then reload."
        action={<Button onClick={() => status.refetch()}>Check again</Button>}
      />,
    );
  }

  if (!status.data.reachable) {
    return frame(
      <EmptyState
        title="Control plane unreachable"
        description={`The control plane at ${status.data.apiUrl} is not responding. Confirm it is running, then retry.`}
        action={<Button onClick={() => status.refetch()}>Retry</Button>}
      />,
    );
  }

  if (zones.length === 0) {
    return frame(
      <EmptyState
        title="No zones yet"
        description="Zones are Caracal's primary trust boundary. Create your first zone to manage applications, resources, and policies."
        action={
          <Link to={appLink("/zones")}>
            <Button>Go to Zones</Button>
          </Link>
        }
      />,
    );
  }

  if (!activeZone) return frame(<LoadingBody />);

  const readOnly = isSystemZone(activeZone);
  if (!readOnly) return <>{children(activeZone)}</>;

  return (
    <ViewOnlyProvider
      readOnly
      reason="Caracal governs this internal system zone - it is shown read-only for transparency."
    >
      {children(activeZone)}
    </ViewOnlyProvider>
  );
}
