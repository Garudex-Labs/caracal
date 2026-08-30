// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth client - the single authentication surface for the web app.
 *
 * Sessions are HttpOnly cookies managed by the identity service (routed at
 * /api/auth by nginx). Registry API calls authenticate with short-lived
 * JWTs fetched through this client (see lib/api.ts).
 */

import { passkeyClient } from "@better-auth/passkey/client";
import { ssoClient } from "@better-auth/sso/client";
import {
	adminClient,
	deviceAuthorizationClient,
	magicLinkClient,
	organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const DEVICE_ID_COOKIE = "caracal_device_id";
const DEVICE_ID_MAX_AGE = 60 * 60 * 24 * 365;

function ensureBrowserDeviceCookie() {
	if (typeof document === "undefined") return;
	const existing = document.cookie
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${DEVICE_ID_COOKIE}=`));
	if (existing) return;
	const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `${DEVICE_ID_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${DEVICE_ID_MAX_AGE}; SameSite=Lax${secure}`;
}

ensureBrowserDeviceCookie();

export const authClient = createAuthClient({
	baseURL:
		typeof window !== "undefined"
			? `${window.location.origin}/api/auth`
			: "http://localhost:8000/api/auth",
	plugins: [
		adminClient(),
		organizationClient({ teams: { enabled: true } }),
		passkeyClient(),
		magicLinkClient(),
		ssoClient(),
		deviceAuthorizationClient(),
	],
});

export type AuthClient = typeof authClient;
