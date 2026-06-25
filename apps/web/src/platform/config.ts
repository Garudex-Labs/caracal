/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file exposes runtime configuration for the web client.
*/
const env = import.meta.env;

// The backend-for-frontend origin. When VITE_CARACAL_AUTH_URL is set (local development's
// separate Vite dev server, or a split deployment), it is used verbatim. Otherwise the SPA is
// served same-origin by the BFF itself, so every API and auth call is relative to the page
// origin — no cross-origin requests, and therefore no CORS or cross-site cookie concerns.
function resolveAuthBase(): string {
  const configured = (env.VITE_CARACAL_AUTH_URL as string | undefined)?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

const authBaseUrl = resolveAuthBase();

export const config = {
  authBaseUrl,
  consoleBaseUrl: `${authBaseUrl}/api/console`,
  docsUrl: "https://docs.caracal.run",
  enterpriseUrl: "https://caracal.run/enterprise",
};
