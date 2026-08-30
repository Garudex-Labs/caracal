// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "@playwright/test";
import { adminCredentials, loginToWebUI } from "./helpers";

/**
 * P0: Login with wrong password - error shown
 * Issue #927
 */
test("login with wrong password shows error and stays on /login", async ({ page }) => {
  const { email } = adminCredentials();
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", "wrong-password-123");
  await page.click('button[type="submit"]');

  // Should stay on /login
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  // Error message should appear
  await expect(page.locator("span").filter({ hasText: /invalid|incorrect|wrong|failed|credentials|password/i }).first()).toBeVisible({ timeout: 10_000 });
});

/**
 * P0: Logout - redirected to /login, protected pages inaccessible
 * Issue #927
 */
test("logout redirects to /login and blocks protected pages", async ({ page }) => {
  // Establish a signed-in session inside the app (follows the org-origin hop).
  await loginToWebUI(page);

  // Open the account menu and click Sign out
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.locator("text=Sign out").click();

  // Should redirect to /login
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  // Protected page should redirect back to /login
  await page.goto("/intelligence");
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});
