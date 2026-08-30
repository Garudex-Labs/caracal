// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/lib/theme";
import { makeQueryClient } from "@/lib/query-client";
import { DynamicTitle } from "@/components/dynamic-title";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { VersionMismatchBanner } from "@/components/shared/version-mismatch-banner";
import "@/app.css";

function RootComponent() {
  const [queryClient] = useState(makeQueryClient);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Outlet />
          <VersionMismatchBanner />
        </ThemeProvider>
        <DynamicTitle />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
