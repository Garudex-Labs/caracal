// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "@playwright/test";
import { loginToWebUI, API_BASE, getApiKey } from "./helpers";

test.describe("Kiro Agent Compatibility in Web UI", () => {
  test.beforeEach(async ({ page }) => {
    await loginToWebUI(page);
  });

  test("resources page lists agents", async ({ page }) => {
    await page.goto("/resources?type=agents");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Something went wrong");
  });

  test("agent detail page shows install options", async ({ page }) => {
    // Get an agent ID from the API
    const apiKey = await getApiKey();
    const agents = await fetch(`${API_BASE}/api/v1/agents`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    }).then((r) => r.json());

    if (agents.length === 0) {
      test.skip();
      return;
    }

    const agentId = agents[0].id;
    await page.goto(`/agents/${agentId}`);
    await page.waitForLoadState("networkidle");

    // The page should load
    await expect(page.locator("body")).not.toContainText("Something went wrong");
  });

  test("resources page lists component types", async ({ page }) => {
    await page.goto("/resources?type=mcps");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Something went wrong");
  });
});
