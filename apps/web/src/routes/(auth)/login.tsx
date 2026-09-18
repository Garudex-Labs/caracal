// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { searchString } from "@/lib/search-params";
import { canonicalBareLoginUrl } from "@/lib/tenant-host";

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
  // The login surface is canonical and clean: strip any org subdomain, project
  // prefix, and every query/hash param (a leaked `next` or previous location)
  // before rendering, so login always starts at exactly `{base}/login` and can
  // never loop through a workspace whose session it cannot establish.
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    const bare = canonicalBareLoginUrl();
    if (bare) window.location.replace(bare);
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
