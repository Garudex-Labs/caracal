/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the 403 error route.
*/
import { createFileRoute } from "@tanstack/react-router";

import { ErrorState } from "@/components/ErrorState";

export const Route = createFileRoute("/403")({
  head: () => ({ meta: [{ title: "403 — Access denied · Caracal" }] }),
  component: ForbiddenPage,
});

function ForbiddenPage() {
  return <ErrorState code={403} />;
}
