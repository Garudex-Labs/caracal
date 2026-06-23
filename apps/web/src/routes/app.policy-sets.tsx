/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file redirects the legacy Policy Sets route into the unified Policies workspace.
*/
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/policy-sets")({
  beforeLoad: () => {
    throw redirect({ to: "/app/policies" });
  },
});
