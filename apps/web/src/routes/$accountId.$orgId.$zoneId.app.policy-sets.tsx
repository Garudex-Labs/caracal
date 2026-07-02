/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file redirects the legacy Policy Sets route into the unified Policies workspace.
*/
import { appLink } from "@/platform/nav/appLink";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/policy-sets")({
  beforeLoad: () => {
    throw redirect({ to: appLink("/policies") });
  },
});
