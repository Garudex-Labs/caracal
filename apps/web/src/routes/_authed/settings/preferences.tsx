// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const PreferencesSettingsPage = lazy(() => import("@/pages/settings/preferences"));

export const Route = createFileRoute("/_authed/settings/preferences")({
	component: PreferencesSettingsPage,
});
