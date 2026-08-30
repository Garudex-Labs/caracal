// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "@playwright/test";
import { loginToWebUI, API_BASE, getAccessToken } from "./helpers";

/**
 * Frontend E2E tests - browser-level tests that drive the Next.js UI
 * and verify real user flows.
 */
test.describe("Frontend Flows", () => {
  // Use an existing approved agent for search/detail tests
  let agentName: string;

  test.beforeAll(async () => {
    const token = await getAccessToken();
    // Resources are project-scoped: resolve the admin's working context and
    // seed inside it, so the UI list actually contains the agent.
    const snapRes = await fetch(`${API_BASE}/api/v1/onboarding`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const snap = await snapRes.json();
    const org = (snap.organizations ?? []).find((o: any) => o.projects.length > 0);
    if (!org) throw new Error("admin has no accessible project; onboarding should have created one");
    const tenancy = { "X-Caracal-Org": org.slug, "X-Caracal-Project": org.projects[0].slug };

    // Always seed a fresh agent inside the project: the resources view is
    // project-scoped and paginated, so only a project-bound row is reliable.
    agentName = `e2e-agent-${Date.now()}`;
    const createRes = await fetch(`${API_BASE}/api/v1/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...tenancy,
      },
      body: JSON.stringify({
        name: agentName,
        description: "Agent for frontend e2e tests",
        version: "1.0.0",
        owner: "admin",
        model_name: "claude-sonnet-4-20250514",
        prompt: "You are a test agent.",
        goal_template: { description: "e2e test", sections: [{ name: "default" }] },
      }),
    });
    const created = await createRes.json();
    const agentId = created.id;
    if (agentId) {
      await fetch(`${API_BASE}/api/v1/review/agents/${agentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ notes: "e2e auto-approve" }),
      });
      // Wait for approval to propagate
      await new Promise((r) => setTimeout(r, 1000));
    } else {
      // Creation failed (e.g. schema mismatch) - fall back to any existing agent
      const fallback = await fetch(`${API_BASE}/api/v1/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const all = await fallback.json();
      if (Array.isArray(all) && all.length > 0) agentName = all[0].name;
    }
  });

  /**
   * Flow 2: Registry home → search for an agent → open agent detail page
   */
  test("search for agent and open detail", async ({ page }) => {
    await loginToWebUI(page);
    await page.goto("/resources?type=agents");
    await page.waitForLoadState("networkidle");

    // Use the search input on the resources page
    const searchInput = page.locator('input[placeholder*="Search"], input[type="search"]').first();
    await searchInput.fill(agentName);
    // Wait for results to filter (debounced)
    await page.waitForTimeout(1000);

    // Click the agent in results
    const agentLink = page.locator(`a:has-text("${agentName}")`).first();
    await expect(agentLink).toBeVisible({ timeout: 20_000 });
    await agentLink.click();

    // Should land on agent detail page
    await page.waitForURL(/\/agents\//, { timeout: 10_000 });
    await expect(page.locator("body")).toContainText(agentName);
  });

  /**
   * Flow 3: Agent detail page → copy pull command → verify copy button works
   */
  test("copy pull command on agent detail", async ({ page, context }) => {
    await loginToWebUI(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/agents/${agentName}`);
    await page.waitForLoadState("networkidle");

    // The install command now lives in the detail sidebar.
    const copyBtn = page.getByRole("button", { name: "Copy command" }).first();
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });
    await copyBtn.click();

    // After clicking, a toast "Copied to clipboard" appears
    await expect(page.locator("text=Copied to clipboard")).toBeVisible({ timeout: 3_000 });

    // Verify clipboard contains the pull command
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain("caracal agent pull");
    expect(clipboardText).toContain(agentName);
  });

  /**
   * Flow 4: Resources → filter by component type (MCP / skill / hook) → results update
   */
  test("resources filter by component type", async ({ page }) => {
    await loginToWebUI(page);
    await page.goto("/resources?type=mcps");
    await page.waitForLoadState("networkidle");

    const typeButton = page.getByRole("button", { name: "Resource type" });
    await expect(typeButton).toBeVisible();
    await expect(typeButton).toContainText("MCPs");

    // Switch the type facet through the dropdown - the URL is the source of truth
    await typeButton.click();
    await page.getByRole("menuitemradio", { name: /Skills/ }).click();
    await page.waitForURL(/type=skills/, { timeout: 10_000 });
    await expect(typeButton).toContainText("Skills");

    await typeButton.click();
    await page.getByRole("menuitemradio", { name: /Hooks/ }).click();
    await page.waitForURL(/type=hooks/, { timeout: 10_000 });
    await expect(typeButton).toContainText("Hooks");
  });
});
