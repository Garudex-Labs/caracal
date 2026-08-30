// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Onboarding lifecycle against the real stack: authenticate → profile →
// create or join an organization → resolve project access → enter the app.
// Self-contained: every account is provisioned through the real sign-up
// flow, so no seeded credentials are required.

import { test, expect, Page } from "@playwright/test";
import { API_BASE, identityLogin, waitForAPI } from "./helpers";

const PASSWORD = "OnboardingE2e!12345";
const RUN = Math.random().toString(36).slice(2, 8);

async function signUp(email: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: API_BASE },
      body: JSON.stringify({ email, password: PASSWORD, name }),
    });
    if (res.ok) return;
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 12_000));
      continue;
    }
    throw new Error(`sign-up failed for ${email}: status=${res.status} ${await res.text()}`);
  }
  throw new Error(`sign-up rate limited for ${email}`);
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/** Establish the identity session cookie in-page and reload (any account). */
async function webLogin(page: Page, email: string) {
  await page.goto("/login");
  for (let attempt = 0; attempt < 5; attempt++) {
    const status = await page.evaluate(
      async ({ email, password }) => {
        const res = await fetch("/api/auth/sign-in/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email, password }),
        });
        return res.status;
      },
      { email, password: PASSWORD },
    );
    if (status >= 200 && status < 300) return;
    if (status !== 429) throw new Error(`web sign-in failed for ${email}: status=${status}`);
    await page.waitForTimeout(12_000);
  }
  throw new Error(`web sign-in rate limited for ${email}`);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await waitForAPI();
});

test("API lifecycle: profile → create org → invite → project access, all idempotent", async () => {
  test.setTimeout(180_000);
  const ownerEmail = `onb-owner-${RUN}@example.com`;
  await signUp(ownerEmail, "Onboarding Owner");
  const owner = await identityLogin(ownerEmail, PASSWORD);

  // A fresh account starts at the profile stage with nothing implicit.
  let snap = (await api(owner, "GET", "/onboarding")).data;
  expect(snap.next_step).toBe("profile");
  expect(snap.organizations).toEqual([]);

  // Profile completion is idempotent.
  expect((await api(owner, "POST", "/onboarding/profile/complete")).status).toBe(200);
  expect((await api(owner, "POST", "/onboarding/profile/complete")).status).toBe(200);
  snap = (await api(owner, "GET", "/onboarding")).data;
  expect(snap.next_step).toBe("organization");

  // Creating the organization yields the protected default project; a
  // duplicate submit conflicts instead of duplicating.
  const orgSlug = `onb-org-${RUN}`;
  const created = await api(owner, "POST", "/orgs", { name: `Onb Org ${RUN}`, slug: orgSlug });
  expect(created.status).toBe(201);
  expect(created.data.default_project?.is_default).toBe(true);
  expect(created.data.default_project?.slug).toBe(orgSlug);
  expect((await api(owner, "POST", "/orgs", { name: "Again", slug: orgSlug })).status).toBe(409);

  snap = (await api(owner, "GET", "/onboarding")).data;
  expect(snap.next_step).toBe("done");
  expect(snap.organizations[0].projects.map((p: any) => p.slug)).toEqual([orgSlug]);

  // The default project refuses deletion.
  expect((await api(owner, "DELETE", `/orgs/${orgSlug}/projects/${orgSlug}`)).status).toBe(409);

  // Inviting the same address twice returns the same live invitation.
  const inviteeEmail = `onb-member-${RUN}@example.com`;
  const inv = await api(owner, "POST", `/orgs/${orgSlug}/invitations`, { email: inviteeEmail, role: "member" });
  expect(inv.status).toBe(201);
  expect(inv.data.url).toContain("/onboarding/organization?invite=");
  const dup = await api(owner, "POST", `/orgs/${orgSlug}/invitations`, { email: inviteeEmail, role: "member" });
  expect(dup.status).toBe(200);
  expect(dup.data.id).toBe(inv.data.id);

  // The invitee joins: org membership does NOT grant project access.
  await signUp(inviteeEmail, "Onboarding Member");
  const invitee = await identityLogin(inviteeEmail, PASSWORD);
  const mine = (await api(invitee, "GET", "/invitations")).data;
  expect(mine.map((i: any) => i.id)).toContain(inv.data.id);
  expect((await api(invitee, "POST", "/onboarding/profile/complete")).status).toBe(200);
  expect((await api(invitee, "POST", `/invitations/${inv.data.id}/accept`)).status).toBe(200);
  // Accepting again is a no-op success.
  expect((await api(invitee, "POST", `/invitations/${inv.data.id}/accept`)).status).toBe(200);
  snap = (await api(invitee, "GET", "/onboarding")).data;
  expect(snap.next_step).toBe("project");
  expect(snap.organizations[0].slug).toBe(orgSlug);
  expect(snap.organizations[0].projects).toEqual([]);

  // A different account can never consume someone else's invitation id.
  const strangerEmail = `onb-stranger-${RUN}@example.com`;
  await signUp(strangerEmail, "Onboarding Stranger");
  const stranger = await identityLogin(strangerEmail, PASSWORD);
  expect((await api(stranger, "POST", `/invitations/${inv.data.id}/accept`)).status).toBe(404);

  // Granting project membership completes onboarding; revoking it returns
  // the member to the no-access state - stale context never survives.
  const inviteeId = (await api(invitee, "GET", "/auth/whoami")).data.id;
  expect(
    (await api(owner, "POST", `/orgs/${orgSlug}/projects/${orgSlug}/members`, { user_id: inviteeId, role: "user" }))
      .status,
  ).toBe(200);
  snap = (await api(invitee, "GET", "/onboarding")).data;
  expect(snap.next_step).toBe("done");
  expect(
    (await api(owner, "DELETE", `/orgs/${orgSlug}/projects/${orgSlug}/members/${inviteeId}`)).status,
  ).toBe(204);
  snap = (await api(invitee, "GET", "/onboarding")).data;
  expect(snap.next_step).toBe("project");

  // A revoked invitation cannot be accepted.
  const inv2 = await api(owner, "POST", `/orgs/${orgSlug}/invitations`, { email: strangerEmail, role: "member" });
  expect(inv2.status).toBe(201);
  expect((await api(owner, "DELETE", `/orgs/${orgSlug}/invitations/${inv2.data.id}`)).status).toBe(204);
  expect((await api(stranger, "POST", `/invitations/${inv2.data.id}/accept`)).status).toBe(409);
});

test("UI lifecycle: profile stage → create org → enter the new workspace", async ({ page }) => {
  test.setTimeout(240_000);
  const email = `onb-ui-${RUN}@example.com`;
  await signUp(email, "Onboarding UI");
  await webLogin(page, email);

  // Any app URL routes into the required stage - including direct entry.
  await page.goto("/resources");
  await page.waitForURL(/\/onboarding\/profile/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Set up your profile" })).toBeVisible();

  await page.fill("#onboarding-name", "Onboarding UI");
  // Refreshing mid-stage resumes exactly where the user was.
  await page.reload();
  await page.waitForURL(/\/onboarding\/profile/);
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.waitForURL(/\/onboarding\/organization/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Join your team or start fresh" })).toBeVisible();
  await expect(page.getByText(`Invitations for ${email}`)).toBeVisible();

  // Skipping ahead by URL is corrected back to the server's stage.
  await page.goto("/onboarding/project");
  await page.waitForURL(/\/onboarding\/organization/, { timeout: 30_000 });

  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/onboarding\/organization\/new/);
  await page.fill("#org-name", `UI Org ${RUN}`);
  await expect(page.locator("#org-slug")).toHaveValue(`ui-org-${RUN}`);
  await page.getByRole("button", { name: /Create organization/ }).click();

  // Entry is a hard navigation to the org's own origin (subdomain tenancy).
  await page.waitForURL(new RegExp(`ui-org-${RUN}\\.localhost`), { timeout: 30_000 });
  expect(new URL(page.url()).hostname).toBe(`ui-org-${RUN}.localhost`);
});

test("UI no-project-access state: waiting, not rejected, until access is granted", async ({ page }) => {
  test.setTimeout(240_000);
  // Owner and org come from the API flow; provision a fresh member.
  const ownerEmail = `onb-owner-${RUN}@example.com`;
  const owner = await identityLogin(ownerEmail, PASSWORD);
  const orgSlug = `onb-org-${RUN}`;
  const memberEmail = `onb-waiting-${RUN}@example.com`;
  await signUp(memberEmail, "Onboarding Waiting");
  const member = await identityLogin(memberEmail, PASSWORD);
  await api(member, "POST", "/onboarding/profile/complete");
  const inv = await api(owner, "POST", `/orgs/${orgSlug}/invitations`, { email: memberEmail, role: "member" });
  expect([200, 201]).toContain(inv.status);
  expect((await api(member, "POST", `/invitations/${inv.data.id}/accept`)).status).toBe(200);

  await webLogin(page, memberEmail);
  await page.goto("/");
  await page.waitForURL(/\/onboarding\/project/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Your project access is pending" })).toBeVisible();
  await expect(page.getByText("Member · no project access")).toBeVisible();

  // Access appears without losing the membership context.
  const memberId = (await api(member, "GET", "/auth/whoami")).data.id;
  expect(
    (await api(owner, "POST", `/orgs/${orgSlug}/projects/${orgSlug}/members`, { user_id: memberId, role: "user" }))
      .status,
  ).toBe(200);
  await page.getByRole("button", { name: /Check again/ }).click();
  // A single accessible project resolves automatically into the workspace.
  await page.waitForURL(new RegExp(`${orgSlug}\\.localhost`), { timeout: 30_000 });
  expect(new URL(page.url()).hostname).toBe(`${orgSlug}.localhost`);
});
