// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const SecuritySettingsPage = lazy(() => import("@/pages/settings/security"));

export const Route = createFileRoute("/_authed/settings/security")({
	component: SecuritySettingsPage,
});
