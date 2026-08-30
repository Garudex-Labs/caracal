// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { RegistrySidebar } from "@/components/nav/registry-sidebar";
import { CommandMenu } from "@/components/nav/command-menu";
import { AppTopBar } from "@/components/layouts/app-top-bar";
import { UtilityRail } from "@/components/layouts/utility-rail";
import { PageChromeProvider } from "@/components/layouts/page-chrome";
import { Toaster } from "@/components/ui/sonner";
import { AuthGuard } from "@/components/layouts/auth-guard";
import { OnboardingGate } from "@/components/layouts/onboarding-gate";
import { ProjectGate } from "@/components/layouts/project-gate";
import { HelpProvider } from "@/components/help/help-context";

function AuthedLayout() {
  return (
    <AuthGuard>
      <OnboardingGate>
        <HelpProvider>
          <PageChromeProvider>
            <SidebarProvider>
              <RegistrySidebar />
              {/* Top bar sits outside the scroll container so the scrollbar spans only the content region below it. */}
              <div className="flex min-w-0 flex-1 flex-col">
                <AppTopBar />
                <SidebarInset>
                  <Suspense fallback={<div className="flex h-full w-full items-center justify-center" />}>
                    <ProjectGate>
                      <Outlet />
                    </ProjectGate>
                  </Suspense>
                </SidebarInset>
              </div>
              <UtilityRail />
              <CommandMenu />
              <Toaster visibleToasts={1} />
            </SidebarProvider>
          </PageChromeProvider>
        </HelpProvider>
      </OnboardingGate>
    </AuthGuard>
  );
}

export const Route = createFileRoute("/_authed")({
  component: AuthedLayout,
});
