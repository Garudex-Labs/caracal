/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the authenticated Console layout route.
*/
import { createFileRoute } from "@tanstack/react-router";

import { ConsoleLayout } from "@/components/console/ConsoleLayout";
import { requireOnboardedInstallation } from "@/platform/auth/guards";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app")({
  beforeLoad: requireOnboardedInstallation,
  component: ConsoleLayout,
});
