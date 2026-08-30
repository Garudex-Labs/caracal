// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "../../tests/e2e",
  timeout: 60_000,
  retries: 1,
  use: {
    // CI: Docker stack serves on port 80 via lb
    // Local: Vite dev server on port 8000
    baseURL: isCI ? "http://localhost:80" : "http://localhost:8000",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // Only start dev server locally; CI uses Docker stack
  webServer: isCI
    ? undefined
    : {
        command: "pnpm dev",
        port: 8000,
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
