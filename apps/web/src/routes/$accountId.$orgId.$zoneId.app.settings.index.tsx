/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file redirects the bare Settings path to the Profile page.
*/
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$accountId/$orgId/$zoneId/app/settings/profile",
      params,
      replace: true,
    });
  },
});
