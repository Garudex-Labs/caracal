// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { searchString } from "@/lib/search-params";

const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));

export type ResetPasswordSearch = {
  token?: string;
  error?: string;
};

function ResetPasswordRoute() {
  return (
    <div className="min-h-dvh bg-background">
      <Suspense fallback={<div className="flex h-screen w-full items-center justify-center" />}>
        <ResetPasswordPage />
      </Suspense>
      <Toaster visibleToasts={1} />
    </div>
  );
}

export const Route = createFileRoute("/(auth)/reset-password")({
  component: ResetPasswordRoute,
  validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => ({
    token: searchString(search.token),
    error: searchString(search.error),
  }),
});
