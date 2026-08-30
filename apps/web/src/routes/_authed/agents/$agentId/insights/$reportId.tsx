// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";

const InsightDetail = lazy(() => import("@/pages/admin/insights/detail"));

export const Route = createFileRoute("/_authed/agents/$agentId/insights/$reportId")({
  component: InsightDetail,
});
