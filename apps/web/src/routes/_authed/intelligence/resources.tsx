// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";

const ResourcesPage = lazy(() => import("@/pages/project/intelligence/resource-index"));

export const Route = createFileRoute("/_authed/intelligence/resources")({
	component: ResourcesPage,
});
