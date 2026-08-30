// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const ProfileSettingsPage = lazy(() => import("@/pages/settings/profile"));

export const Route = createFileRoute("/_authed/settings/profile")({
	component: ProfileSettingsPage,
});
