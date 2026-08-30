// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { searchString } from "@/lib/search-params";

const RegisterPage = lazy(() => import("@/pages/register"));

export type RegisterSearch = {
  next?: string;
};

function RegisterRoute() {
  return (
    <div className="min-h-dvh bg-background">
      <Suspense fallback={<div className="flex h-screen w-full items-center justify-center" />}>
        <RegisterPage />
      </Suspense>
      <Toaster visibleToasts={1} />
    </div>
  );
}

export const Route = createFileRoute("/(auth)/register")({
  component: RegisterRoute,
  validateSearch: (search: Record<string, unknown>): RegisterSearch => ({
    next: searchString(search.next),
  }),
});
