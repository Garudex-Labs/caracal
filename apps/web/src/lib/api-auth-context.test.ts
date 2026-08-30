// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	activateAuthContext,
	authContextForPath,
	clearStoredAuthContext,
	getStoredAccessToken,
	hasActiveAuthContext,
	setStoredAccessToken,
} from "./auth-context.ts";

class MemoryStorage {
	#values = new Map<string, string>();
	getItem(key: string) {
		return this.#values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.#values.set(key, value);
	}
	removeItem(key: string) {
		this.#values.delete(key);
	}
	clear() {
		this.#values.clear();
	}
}

function installBrowserStubs() {
	const sessionStorage = new MemoryStorage();
	const localStorage = new MemoryStorage();
	Object.assign(globalThis, {
		window: { dispatchEvent: () => true },
		sessionStorage,
		localStorage,
	});
	return { sessionStorage, localStorage };
}

function token(payload: Record<string, unknown>) {
	return ["header", btoa(JSON.stringify(payload)), "signature"].join(".");
}

afterEach(() => {
	delete (globalThis as { window?: unknown }).window;
	delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
	delete (globalThis as { localStorage?: unknown }).localStorage;
	delete (globalThis as { fetch?: unknown }).fetch;
});

test("context token stores reject tokens minted for another context", () => {
	const { sessionStorage } = installBrowserStubs();
	sessionStorage.setItem("caracal_tenant_access_token", token({ auth_context: "operator", exp: 4_102_444_800 }));
	assert.equal(getStoredAccessToken("tenant"), null);
	assert.equal(sessionStorage.getItem("caracal_tenant_access_token"), null);
});

test("active contexts store only their own token", () => {
	installBrowserStubs();
	const minted = token({ auth_context: "operator", exp: 4_102_444_800 });
	activateAuthContext("operator");
	setStoredAccessToken("operator", minted);
	assert.equal(hasActiveAuthContext("operator"), true);
	assert.equal(getStoredAccessToken("operator"), minted);
	assert.equal(getStoredAccessToken("tenant"), null);
});

test("clearing one context does not leave tenant org/project state behind", () => {
	const { localStorage } = installBrowserStubs();
	activateAuthContext("tenant");
	localStorage.setItem("caracal_current_org", "acme");
	localStorage.setItem("caracal_current_project", JSON.stringify({ acme: "platform" }));
	clearStoredAuthContext("tenant");
	assert.equal(hasActiveAuthContext("tenant"), false);
	assert.equal(localStorage.getItem("caracal_current_org"), null);
	assert.equal(localStorage.getItem("caracal_current_project"), null);
});

test("route-family classifier keeps operator and tenant API contexts separate", () => {
	assert.equal(authContextForPath("/operator"), "operator");
	assert.equal(authContextForPath("/operator/security-events"), "operator");
	assert.equal(authContextForPath("/exec/adoption"), "operator");
	assert.equal(authContextForPath("/support/collect"), "operator");
	assert.equal(authContextForPath("/telemetry/status"), "operator");
	assert.equal(authContextForPath("/dashboard/harness-usage"), "operator");
	assert.equal(authContextForPath("/dashboard/tokens"), "tenant");
	assert.equal(authContextForPath("/dashboard/tokens?range=7d"), "tenant");
	assert.equal(authContextForPath("/orgs/acme"), "tenant");
	assert.equal(authContextForPath("/resources"), "tenant");
});
