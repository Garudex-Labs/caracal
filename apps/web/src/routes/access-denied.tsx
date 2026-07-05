/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the deployment access-denied page shown for every allowlist denial.
*/
import { createFileRoute, Link } from "@tanstack/react-router";

import { content } from "@/platform/content/resolver";

export const Route = createFileRoute("/access-denied")({
  head: () => ({ meta: [{ title: "Access denied · Caracal" }] }),
  component: AccessDeniedPage,
});

// One deliberately uniform page for every denial. Whether the email was never allowed, locked,
// or removed is a deployment-owner decision the person is not told; the server enforces the
// consequences before the browser lands here, so this page is purely presentational and safe
// to visit directly.
function AccessDeniedPage() {
  const t = content.auth;
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-16">
      <Link
        to="/"
        aria-label="Caracal home"
        className="absolute left-6 top-6 z-30 flex items-center transition-opacity hover:opacity-80"
      >
        <img
          src="/caracal_light.png"
          alt="Caracal"
          className="h-auto w-40 select-none object-contain dark:hidden sm:w-56"
        />
        <img
          src="/caracal_dark.png"
          alt="Caracal"
          className="hidden h-auto w-40 select-none object-contain dark:block sm:w-56"
        />
      </Link>

      <main className="relative z-10 w-full max-w-md">
        <div className="rounded-2xl border border-border bg-card p-8 shadow-2xl sm:p-10">
          <div
            aria-hidden
            className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-6 w-6"
            >
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t.accessDeniedTitle}
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{t.accessDeniedBody}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t.accessDeniedHint}</p>

          <Link
            to="/sign-in"
            className="mt-8 inline-flex h-10 w-full items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            {t.accessDeniedCta}
          </Link>
        </div>
      </main>
    </div>
  );
}
