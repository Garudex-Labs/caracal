// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  // The suite drives one shared stack; parallel workers race on seed data.
  workers: 1,
  use: {
    baseURL: process.env.WEB_BASE ?? "http://localhost",
  },
});
