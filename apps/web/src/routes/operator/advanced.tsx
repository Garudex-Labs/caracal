// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const InstanceAdvancedPage = lazy(() => import("@/pages/settings/instance-advanced"));

export const Route = createFileRoute("/operator/advanced")({
	component: InstanceAdvancedPage,
});
