// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "@playwright/test";
import { getAccessToken, loginToWebUI, API_BASE } from "./helpers";

const WEB_BASE = "http://localhost:8000";

test.describe("Visibility removal smoke test", () => {
  test("Agent list page loads without visibility UI", async ({ page }) => {
    await page.goto(`${WEB_BASE}/resources?type=agents`);
    await page.waitForLoadState("networkidle");

    // Page should not have visibility-related UI elements
    await expect(page.locator("h3:has-text('Visibility')")).not.toBeVisible();
    await expect(page.locator("text=Team Access")).not.toBeVisible();
  });

  test("Agent detail page has no access settings widget", async ({ page }) => {
    await loginToWebUI(page);
    await page.goto(`${WEB_BASE}/resources?type=agents`);
    await page.waitForLoadState("networkidle");

    // Click first agent
    const firstAgent = page.locator('a[href*="/agents/"]').first();
    await firstAgent.click();
    await page.waitForLoadState("networkidle");

    // No visibility or access settings UI
    await expect(page.locator("text=Access Settings")).not.toBeVisible();
    await expect(page.locator("h3:has-text('Visibility')")).not.toBeVisible();
    await expect(page.locator("text=Team Permissions")).not.toBeVisible();
  });

  test("Agent builder has no visibility or team access section", async ({ page }) => {
    await loginToWebUI(page);
    await page.goto(`${WEB_BASE}/agents/new`);
    await page.waitForLoadState("networkidle");

    // No team access grant UI
    await expect(page.locator("text=Visibility & Access")).not.toBeVisible();
    await expect(page.locator("h3:has-text('Team Access')")).not.toBeVisible();
    await expect(page.locator("text=Private (Team Access Only)")).not.toBeVisible();
  });

  test("API response has no visibility or team_accesses fields", async ({ request }) => {
    const token = await getAccessToken();
    const res = await request.get(`${API_BASE}/api/v1/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const agents = await res.json();
    expect(agents.length).toBeGreaterThan(0);

    for (const agent of agents) {
      expect(agent).not.toHaveProperty("team_accesses");
      // The only supported scopes are project and private; public is gone.
      if (agent.visibility) expect(["project", "private"]).toContain(agent.visibility);
    }

    // Check detail endpoint
    const detailRes = await request.get(`${API_BASE}/api/v1/agents/${agents[0].id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(detailRes.ok()).toBeTruthy();
    const detail = await detailRes.json();
    expect(detail).not.toHaveProperty("team_accesses");
    if (detail.visibility) expect(["project", "private"]).toContain(detail.visibility);
  });

  test("submitting a component as public is rejected", async ({ request }) => {
    const token = await getAccessToken();
    const res = await request.post(`${API_BASE}/api/v1/mcps/submit`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: "vis-smoke-public",
        version: "1.0.0",
        description: "public should be rejected",
        command: "npx",
        visibility: "public",
      },
    });
    // The server accepts only project/private now.
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("project");
  });

  test("public MCP listings are never returned", async ({ request }) => {
    const token = await getAccessToken();
    const res = await request.get(`${API_BASE}/api/v1/mcps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const items = await res.json();
    for (const item of items) {
      if (item.visibility) expect(["project", "private"]).toContain(item.visibility);
    }
  });
});
