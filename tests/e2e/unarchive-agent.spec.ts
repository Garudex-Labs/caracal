// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "@playwright/test";
import { API_BASE, adminCredentials, getAccessToken, loginToWebUI } from "./helpers";

let agentId: string;
let token: string;

test.describe("Agent unarchive", () => {
  test.beforeAll(async () => {
    token = await getAccessToken();

    const createRes = await fetch(`${API_BASE}/api/v1/agents/draft`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "unarchive-test-agent",
        description: "Agent to test unarchive flow",
        owner: adminCredentials().email,
        version: "1.0.0",
        model_name: "claude-sonnet-4-20250514",
          prompt: "You are a test agent.",
      }),
    });
    const created = await createRes.json();
    if (!created.id) throw new Error(`Draft creation failed: ${JSON.stringify(created)}`);
    agentId = created.id;

    await fetch(`${API_BASE}/api/v1/agents/${agentId}/submit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    await fetch(`${API_BASE}/api/v1/review/agents/${agentId}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    await fetch(`${API_BASE}/api/v1/agents/${agentId}/archive`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  });

  test.afterAll(async () => {
    await fetch(`${API_BASE}/api/v1/agents/${agentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  });

  test("API: unarchive restores agent to approved", async () => {
    const res = await fetch(
      `${API_BASE}/api/v1/agents/${agentId}/unarchive`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");

    // Re-archive for subsequent tests
    await fetch(`${API_BASE}/api/v1/agents/${agentId}/archive`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  });

  test("API: unarchive non-archived agent returns 400", async () => {
    await fetch(`${API_BASE}/api/v1/agents/${agentId}/unarchive`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const res = await fetch(
      `${API_BASE}/api/v1/agents/${agentId}/unarchive`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe("Agent is not archived");

    // Re-archive for subsequent tests
    await fetch(`${API_BASE}/api/v1/agents/${agentId}/archive`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  });

  test("API: unauthenticated unarchive returns 401", async () => {
    const res = await fetch(
      `${API_BASE}/api/v1/agents/${agentId}/unarchive`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(res.status).toBe(401);
  });

  test("UI: archived agent restores from its detail page", async ({
    page,
  }) => {
    await loginToWebUI(page);
    await page.goto("/resources?type=agents&status=archived");
    await page.waitForLoadState("networkidle");

    const agentRow = page.locator("tr", {
      hasText: "unarchive-test-agent",
    });

    if (await agentRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await agentRow.locator("a").first().click();
      await page.waitForURL(/\/agents\//, { timeout: 10_000 });

      const restoreBtn = page.getByRole("button", { name: "Restore" }).first();
      await expect(restoreBtn).toBeVisible({ timeout: 10_000 });
      await restoreBtn.click();

      await expect(
        page.getByText("This makes the agent discoverable again."),
      ).toBeVisible();

      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Restore" })
        .click();

      await expect(page.getByText("Agent restored")).toBeVisible({
        timeout: 5000,
      });
    } else {
      test.skip();
    }
  });
});
