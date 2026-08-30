// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { searchString } from "@/lib/search-params";

const DevicePage = lazy(() => import("@/pages/device"));

export type DeviceSearch = {
  code?: string;
  sso?: string;
};

function DeviceRoute() {
  return (
    <div className="min-h-dvh bg-background">
      <Suspense fallback={<div className="flex h-screen w-full items-center justify-center" />}>
        <DevicePage />
      </Suspense>
      <Toaster visibleToasts={1} />
    </div>
  );
}

export const Route = createFileRoute("/(auth)/device")({
  component: DeviceRoute,
  validateSearch: (search: Record<string, unknown>): DeviceSearch => ({
    code: searchString(search.code),
    sso: searchString(search.sso),
  }),
});
