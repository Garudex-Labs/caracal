/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the application root route and shell.
*/
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouterState,
  HeadContent,
} from "@tanstack/react-router";

import { ErrorState } from "../components/ErrorState";
import { SiteShell } from "../components/SiteShell";
import { ToastProvider } from "../components/ui/Toast";

const MARKETING_ROUTES = new Set(["/", "/pricing", "/enterprise", "/docs", "/legal", "/community"]);

function usesMarketingShell(pathname: string): boolean {
  return MARKETING_ROUTES.has(pathname);
}
import { errorToStatus } from "../platform/errors/httpError";

function NotFoundComponent() {
  return <ErrorState code={404} />;
}

function ErrorComponent({ error }: { error: Error }) {
  console.error(error);
  const code = errorToStatus(error);

  return <ErrorState code={code} />;
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Caracal" },
      {
        name: "description",
        content:
          "The identity and authorization layer for AI agents. Agents never hold credentials: every action is policy-approved before it runs, revocable in one call, and recorded as tamper-evident evidence.",
      },
      { name: "author", content: "Caracal" },
      {
        property: "og:title",
        content: "Caracal",
      },
      {
        property: "og:description",
        content: "Authority, not credentials, for AI agents.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      {
        name: "twitter:title",
        content: "Caracal",
      },
      {
        name: "twitter:description",
        content: "Authority, not credentials, for AI agents.",
      },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <HeadContent />
      <ToastProvider>
        <RootShell />
      </ToastProvider>
    </QueryClientProvider>
  );
}

function RootShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (usesMarketingShell(pathname)) {
    return (
      <SiteShell>
        <Outlet />
      </SiteShell>
    );
  }

  return <Outlet />;
}
