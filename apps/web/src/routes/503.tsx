/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the 503 error route.
*/
import { createFileRoute } from "@tanstack/react-router";

import { ErrorState } from "@/components/ErrorState";

export const Route = createFileRoute("/503")({
  head: () => ({ meta: [{ title: "503 — Service unavailable · Caracal" }] }),
  component: ServiceUnavailablePage,
});

function ServiceUnavailablePage() {
  return <ErrorState code={503} />;
}
