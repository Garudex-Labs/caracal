// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const ResourcesPage = lazy(() => import("@/pages/resources/index"));

export const RESOURCE_PAGE_SIZES = [10, 25, 50] as const;

export type ResourcesSearch = {
  type?: string;
  q?: string;
  sort?: string;
  scope?: string;
  status?: string;
  owner?: string;
  updated?: string;
  created?: string;
  mine?: boolean;
  wip?: boolean;
  page?: number;
  per?: number;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

export const Route = createFileRoute("/_authed/resources")({
  component: ResourcesPage,
  validateSearch: (search: Record<string, unknown>): ResourcesSearch => ({
    ...(str(search.type) ? { type: str(search.type) } : {}),
    ...(str(search.q) ? { q: str(search.q) } : {}),
    ...(str(search.sort) ? { sort: str(search.sort) } : {}),
    ...(str(search.scope) ? { scope: str(search.scope) } : {}),
    ...(str(search.status) ? { status: str(search.status) } : {}),
    ...(str(search.owner) ? { owner: str(search.owner) } : {}),
    ...(str(search.updated) ? { updated: str(search.updated) } : {}),
    ...(str(search.created) ? { created: str(search.created) } : {}),
    ...(search.mine === true || search.mine === "true" ? { mine: true } : {}),
    ...(search.wip === true || search.wip === "true" ? { wip: true } : {}),
    ...(typeof search.page === "number" && Number.isFinite(search.page) && search.page > 1
      ? { page: Math.floor(search.page) }
      : {}),
    ...(typeof search.per === "number" && (RESOURCE_PAGE_SIZES as readonly number[]).includes(search.per)
      ? { per: search.per }
      : {}),
  }),
});
