// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
import { useRegistryResolve } from "@/hooks/use-api";
import { apiErrorStatus } from "@/lib/api";
import { DetailSkeleton } from "@/components/shared/skeleton-layouts";
import { ErrorState } from "@/components/shared/error-state";
import { NotFoundState } from "@/components/shared/not-found-state";

const AgentBuilder = lazy(() => import("@/pages/registry/agents/builder"));

// Contextual authoring surface: edit THIS agent in the Builder without losing
// the project/agent context. Authorization is server-side - the builder's
// draft/save/submit calls all authorize ownership and scope on the server.
function EditAgentRoute() {
  const { namespace, slug } = Route.useParams();
  const resolve = useRegistryResolve("agents", `${namespace}/${slug}`);
  const status = apiErrorStatus(resolve.error);

  if (resolve.isLoading) {
    return (
      <div className="w-full p-6 lg:p-8">
        <DetailSkeleton />
      </div>
    );
  }
  if (resolve.isError && status !== 404) {
    return (
      <div className="w-full p-6 lg:p-8">
        <ErrorState message={resolve.error?.message} onRetry={() => resolve.refetch()} />
      </div>
    );
  }
  if (!resolve.data) {
    return <NotFoundState title="Agent not found" />;
  }
  return <AgentBuilder editId={resolve.data.id} backTo={{ namespace, slug }} />;
}

export const Route = createFileRoute("/_authed/agents/$namespace/$slug/edit")({
  component: EditAgentRoute,
});
