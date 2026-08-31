// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { searchString } from "@/lib/search-params";
import { canonicalAuthUrl } from "@/lib/tenant-host";

const LoginPage = lazy(() => import("@/pages/login"));

export type LoginSearch = {
  next?: string;
  saml_token?: string;
  code?: string;
  saml_code?: string;
  error?: string;
  reason?: string;
  sso_error?: string;
  sso?: string;
};

function LoginRoute() {
  return (
    <div className="min-h-dvh bg-background">
      <Suspense fallback={<div className="flex h-screen w-full items-center justify-center" />}>
        <LoginPage />
      </Suspense>
      <Toaster visibleToasts={1} />
    </div>
  );
}

export const Route = createFileRoute("/(auth)/login")({
  // The auth surface is canonical: if reached on an org subdomain or under a
  // project prefix, hard-redirect to the org-free `/login` before rendering.
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    const canonical = canonicalAuthUrl();
    if (canonical) window.location.replace(canonical);
  },
  component: LoginRoute,
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    next: searchString(search.next),
    saml_token: searchString(search.saml_token),
    code: searchString(search.code),
    saml_code: searchString(search.saml_code),
    error: searchString(search.error),
    reason: searchString(search.reason),
    sso_error: searchString(search.sso_error),
    sso: searchString(search.sso),
  }),
});
