// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter, Navigate } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { canonicalProjectFreePath, firstSegmentsFromPaths, initTenant } from "@/lib/tenant-host";

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  if (sessionStorage.getItem("caracal_chunk_reload") === "1") return;
  sessionStorage.setItem("caracal_chunk_reload", "1");
  window.location.reload();
});

window.addEventListener("load", () => {
  sessionStorage.removeItem("caracal_chunk_reload");
});

// {org}.{host}/{project}/... - the project prefix becomes the router basepath.
// Project links include that prefix; organization/account/operator routes are
// absolute and canonicalized outside it. A throwaway router resolves route
// first segments so none can be mistaken for a project slug.
const probe = createRouter({ routeTree });
const tenant = initTenant(
  firstSegmentsFromPaths(Object.values(probe.routesById).map((route) => route.fullPath)),
);
const canonicalProjectFree = canonicalProjectFreePath(window.location.pathname, tenant.urlProject);
if (canonicalProjectFree) {
  window.location.replace(`${canonicalProjectFree}${window.location.search}${window.location.hash}`);
}

const router = createRouter({
  routeTree,
  basepath: tenant.urlProject ? `/${tenant.urlProject}` : undefined,
  defaultPreload: "intent",
  // Only current routes exist; anything unmatched (incl. legacy paths like
  // /dashboard or /projects) lands on Home. Item detail pages render
  // their own in-place not-found states.
  defaultNotFoundComponent: () => <Navigate to="/" replace />,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
