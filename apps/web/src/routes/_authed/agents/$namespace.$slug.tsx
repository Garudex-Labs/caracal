// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout segment for one agent's contextual surfaces: the detail page at the
// index and the Builder authoring surface at ./edit.
export const Route = createFileRoute("/_authed/agents/$namespace/$slug")({
  component: Outlet,
});
