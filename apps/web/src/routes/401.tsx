/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the 401 error route.
*/
import { createFileRoute } from "@tanstack/react-router";

import { ErrorState } from "@/components/ErrorState";

export const Route = createFileRoute("/401")({
  head: () => ({ meta: [{ title: "401 — Sign in required · Caracal" }] }),
  component: UnauthorizedPage,
});

function UnauthorizedPage() {
  return <ErrorState code={401} />;
}
