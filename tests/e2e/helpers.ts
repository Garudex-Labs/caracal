// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Page } from "@playwright/test";

/** Base URL for the Caracal API */
export const API_BASE = process.env.API_BASE ?? "http://localhost";

let _cachedToken: string | null = null;

/** Exchange email/password for an API JWT through the identity service.
 * Retries rate-limited sign-ins (3 attempts per 10s window). */
export async function identityLogin(email: string, password: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const signIn = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
      method: "POST",
      // node's fetch sends `Origin: null`, which the CSRF guard rejects.
      headers: { "Content-Type": "application/json", Origin: API_BASE },
      body: JSON.stringify({ email, password }),
    });
    if (signIn.status === 429) {
      await new Promise((r) => setTimeout(r, 12_000));
      continue;
    }
    const session = signIn.headers.get("set-auth-token");
    if (!signIn.ok || !session) {
      throw new Error(`sign-in failed for ${email}: status=${signIn.status} ${await signIn.text()}`);
    }
    const exchange = await fetch(`${API_BASE}/api/auth/token`, {
      headers: { Authorization: `Bearer ${session}` },
    });
    const data = await exchange.json();
    if (!exchange.ok || !data.token) {
      throw new Error(`token exchange failed for ${email}: status=${exchange.status}`);
    }
    return data.token as string;
  }
  throw new Error(`sign-in rate limited for ${email} after retries`);
}

/** Admin credentials for the provisioned test stack. Nothing is seeded:
 * provision an admin account and export these before running the suite. */
export function adminCredentials(): { email: string; password: string } {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to a provisioned admin account");
  }
  return { email, password };
}

/** Get an access token by logging in with the provisioned admin (cached per worker) */
export async function getAccessToken(): Promise<string> {
  if (_cachedToken) return _cachedToken;
  const { email, password } = adminCredentials();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const token = await identityLogin(email, password);
      await ensureOnboarded(token);
      _cachedToken = token;
      return _cachedToken;
    } catch (error) {
      if (String(error).includes("status=429")) {
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Login failed after retries");
}

/** Complete onboarding for the account idempotently: stamp the profile and,
 * when it belongs to no organization, create one (which also creates its
 * default project). Repeat calls are no-ops, so any spec can rely on the
 * admin being past the onboarding gate. */
export async function ensureOnboarded(token: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const read = async () => {
    const res = await fetch(`${API_BASE}/api/v1/onboarding`, { headers });
    if (!res.ok) throw new Error(`onboarding state failed: status=${res.status}`);
    return res.json();
  };
  let snap = await read();
  if (!snap.profile.completed) {
    const res = await fetch(`${API_BASE}/api/v1/onboarding/profile/complete`, { method: "POST", headers });
    if (!res.ok) throw new Error(`profile completion failed: status=${res.status}`);
  }
  if (snap.organizations.length === 0) {
    const base = String(snap.profile.username || "e2e").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const slug = `e2e-${base}`.replace(/-+/g, "-").slice(0, 32).replace(/^-|-$/g, "");
    const res = await fetch(`${API_BASE}/api/v1/orgs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `E2E ${snap.profile.username}`, slug }),
    });
    // 409 = a previous run already created it; the snapshot below settles it.
    if (!res.ok && res.status !== 409) {
      throw new Error(`org creation failed: status=${res.status} ${await res.text()}`);
    }
  }
  snap = await read();
  if (snap.next_step !== "done") {
    throw new Error(`account is still at onboarding step '${snap.next_step}'`);
  }
}

/** @deprecated Use getAccessToken */
export const getApiKey = getAccessToken;

/** Login to the web UI by establishing the identity session cookie in-page.
 * The app bootstraps by exchanging that cookie at /api/auth/token, so a bare
 * sessionStorage token is not enough. Entering the app hops to the org's own
 * origin ({org}.localhost); localhost cookies are host-only, so the session
 * is re-established on every origin the flow lands on (in production the
 * cookie spans subdomains via Domain=.base). */
export async function loginToWebUI(page: Page) {
  const { email, password } = adminCredentials();
  // Settle onboarding first so the UI session lands in the app, not the gate.
  await getAccessToken();
  await page.goto("/");
  await signInOnCurrentOrigin(page, email, password);
  await page.reload();
  await page.waitForLoadState("networkidle");
  for (let hop = 0; hop < 8; hop++) {
    const url = new URL(page.url());
    const inTransit = url.pathname.includes("/login") || url.pathname.startsWith("/onboarding");
    if (!inTransit) return;
    if (url.pathname.includes("/login")) {
      await signInOnCurrentOrigin(page, email, password);
      await page.reload();
    }
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
  }
  throw new Error(`web sign-in never reached the app: ${page.url()}`);
}

async function signInOnCurrentOrigin(page: Page, email: string, password: string) {
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
      { email, password },
    );
    if (status >= 200 && status < 300) return;
    if (status !== 429) throw new Error(`web sign-in failed for ${email}: status=${status}`);
    await page.waitForTimeout(15_000);
  }
  throw new Error(`web sign-in failed for ${email}: rate limited after retries`);
}

/** Wait for API to be healthy */
export async function waitForAPI() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const response = await fetch(`${API_BASE}/health`, {
        signal: AbortSignal.timeout(Math.min(5000, remaining)),
      });
      if (response.ok) return;
    } catch {
      // Retry until the API reaches a healthy state.
    }
    const delay = Math.min(2000, deadline - Date.now());
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("API not healthy after 60s");
}

/** Send a raw OTLP trace payload to simulate Kiro telemetry */
export async function sendKiroOTLPTrace(payload: object) {
  const res = await fetch(`${API_BASE}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/** Send a raw OTLP log payload to simulate Kiro telemetry */
export async function sendKiroOTLPLog(payload: object) {
  const res = await fetch(`${API_BASE}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/** Send a hook event payload to simulate Kiro hook firing */
export async function sendKiroHookEvent(payload: object) {
  const res = await fetch(`${API_BASE}/api/v1/telemetry/hooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/** Build a realistic Kiro OTLP resourceSpans payload */
export function buildKiroOTLPTracePayload(options: {
  traceId: string;
  spanId: string;
  sessionId?: string;
  spanName: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "kiro" } },
            {
              key: "telemetry.sdk.name",
              value: { stringValue: "kiro-cli" },
            },
            ...(options.sessionId
              ? [
                  {
                    key: "session.id",
                    value: { stringValue: options.sessionId },
                  },
                ]
              : []),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "kiro.telemetry" },
            spans: [
              {
                traceId: options.traceId,
                spanId: options.spanId,
                name: options.spanName,
                kind: 3, // CLIENT
                startTimeUnixNano: String(Date.now() * 1_000_000),
                endTimeUnixNano: String((Date.now() + 500) * 1_000_000),
                status: { code: 1 },
                attributes: [
                  ...(options.model
                    ? [
                        {
                          key: "gen_ai.request.model",
                          value: { stringValue: options.model },
                        },
                      ]
                    : []),
                  ...(options.inputTokens != null
                    ? [
                        {
                          key: "gen_ai.usage.input_tokens",
                          value: { intValue: String(options.inputTokens) },
                        },
                      ]
                    : []),
                  ...(options.outputTokens != null
                    ? [
                        {
                          key: "gen_ai.usage.output_tokens",
                          value: { intValue: String(options.outputTokens) },
                        },
                      ]
                    : []),
                ],
                events: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Build a realistic Kiro OTLP resourceLogs payload */
export function buildKiroOTLPLogPayload(options: {
  sessionId: string;
  promptId: string;
  eventName: string;
  body?: string;
  attributes?: Record<string, string>;
}) {
  const attrs = Object.entries(options.attributes ?? {}).map(([key, val]) => ({
    key,
    value: { stringValue: val },
  }));

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "kiro" } },
            {
              key: "session.id",
              value: { stringValue: options.sessionId },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "kiro.telemetry" },
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                severityNumber: 9,
                body: { stringValue: options.body ?? "" },
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: options.eventName },
                  },
                  {
                    key: "session.id",
                    value: { stringValue: options.sessionId },
                  },
                  {
                    key: "prompt.id",
                    value: { stringValue: options.promptId },
                  },
                  ...attrs,
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
