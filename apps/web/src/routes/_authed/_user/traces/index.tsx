// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
import { searchString } from "@/lib/search-params";
const TracesPage = lazy(() => import("@/pages/user/traces/index"));

export const TRACE_PAGE_SIZES = [25, 50, 100] as const;
export const TRACE_RANGES = ["24h", "7d", "30d", "90d", "all"] as const;
export const TRACE_SORTS = ["recent", "oldest", "duration", "tokens", "credits", "prompts", "tools"] as const;

// The URL is the single source of truth for the investigation query:
// search, filters, thresholds, sort, and page all live here so views are
// shareable and survive reloads.
export type TracesSearch = {
  q?: string;
  platform?: string;
  model?: string;
  agent?: string;
  user?: string;
  status?: string;
  range?: string;
  sort?: string;
  minDur?: number;
  minTok?: number;
  page?: number;
  per?: number;
};

const oneOf = (value: unknown, allowed: readonly string[]): string | undefined =>
  typeof value === "string" && allowed.includes(value) ? value : undefined;

const posInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

export const Route = createFileRoute("/_authed/_user/traces/")({
  component: TracesPage,
  validateSearch: (search: Record<string, unknown>): TracesSearch => ({
    q: searchString(search.q),
    platform: searchString(search.platform),
    model: searchString(search.model),
    agent: searchString(search.agent),
    user: searchString(search.user),
    status: oneOf(search.status, ["active", "completed"]),
    range: oneOf(search.range, TRACE_RANGES),
    sort: oneOf(search.sort, TRACE_SORTS),
    minDur: posInt(search.minDur),
    minTok: posInt(search.minTok),
    ...(posInt(search.page) && (posInt(search.page) as number) > 1 ? { page: posInt(search.page) } : {}),
    ...(typeof search.per === "number" && (TRACE_PAGE_SIZES as readonly number[]).includes(search.per)
      ? { per: search.per }
      : {}),
  }),
});
