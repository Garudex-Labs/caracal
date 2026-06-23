/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the 429 error route.
*/
import { createFileRoute } from "@tanstack/react-router";

import { ErrorState } from "@/components/ErrorState";

export const Route = createFileRoute("/429")({
  head: () => ({ meta: [{ title: "429 — Too many requests · Caracal" }] }),
  component: RateLimitedPage,
});

function RateLimitedPage() {
  return <ErrorState code={429} />;
}
