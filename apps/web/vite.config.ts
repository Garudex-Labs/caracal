// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { resolve } from "path";
import { readFileSync } from "fs";
import { mockApiPlugin } from "./mock/plugin";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

// `pnpm dev:mock` serves /api/v1/* from web/mock fixtures instead of proxying
// to the backend, so the frontend can be developed with no server running.
const useMockApi = ["1", "true"].includes(process.env.VITE_MOCK_API ?? "");

export default defineConfig({
  plugins: [
    TanStackRouterVite({ routesDirectory: "./src/routes" }),
    react(),
    ...(useMockApi ? [mockApiPlugin(__dirname)] : []),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
          "vendor-ui": ["@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@radix-ui/react-select", "@radix-ui/react-tabs", "@radix-ui/react-tooltip"],
          "vendor-charts": ["recharts"],
        },
      },
    },
  },
  server: {
    port: 8000,
    // {org}.localhost subdomains are the dev equivalent of org subdomain routing.
    allowedHosts: [".localhost"],
    fs: {
      // The help panel raw-imports markdown from the repo-level docs/ dir.
      allow: [searchForWorkspaceRoot(process.cwd()), resolve(__dirname, "../docs")],
    },
    proxy: {
      // The identity service is only reachable through the stack's load
      // balancer; sending it to the Go API server would 404 every login.
      "/api/auth": {
        target: "http://localhost:80",
        changeOrigin: true,
      },
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
