// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const AgentBuilder = lazy(() => import("@/pages/registry/agents/builder"));

export type NewAgentSearch = {
  /** Resume an existing draft by id. */
  draft?: string;
};

// Authoring surface for a NEW agent. Editing an existing agent lives at its
// contextual URL: /agents/$namespace/$slug/edit.
function NewAgentRoute() {
  const { draft } = Route.useSearch();
  return <AgentBuilder draftId={draft} />;
}

export const Route = createFileRoute("/_authed/agents/new")({
  component: NewAgentRoute,
  validateSearch: (search: Record<string, unknown>): NewAgentSearch => ({
    draft: (search.draft as string) || undefined,
  }),
});
