// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
import { searchString } from "@/lib/search-params";
const ComponentDetail = lazy(() => import("@/pages/registry/components/detail"));

export type ComponentSearch = {
  type?: string;
  view?: string;
};

export const Route = createFileRoute("/_authed/components/$componentId")({
  component: ComponentDetail,
  validateSearch: (search: Record<string, unknown>): ComponentSearch => ({
    type: searchString(search.type) ?? "mcps",
    ...(typeof search.view === "string" ? { view: search.view } : {}),
  }),
});
