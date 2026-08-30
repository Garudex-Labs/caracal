// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const SecurityEventsPage = lazy(() => import("@/pages/admin/security-events"));

export const Route = createFileRoute("/operator/security-events")({
	component: SecurityEventsPage,
});
