// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { canonicalLoginUrl, currentPathAsNext, isSafeNext, safeNext, sessionExpiredLoginUrl, tenantNext } from "./safe-next.ts";

test("accepts a plain relative path", () => {
	assert.equal(isSafeNext("/agents"), true);
	assert.equal(isSafeNext("/agents?tab=versions&page=2"), true);
	assert.equal(isSafeNext("/"), true);
});

test("rejects protocol-relative and absolute redirect targets", () => {
	assert.equal(isSafeNext("//evil.com"), false);
	assert.equal(isSafeNext("//evil.com/phish"), false);
	assert.equal(isSafeNext("https://evil.com"), false);
	assert.equal(isSafeNext("http://evil.com"), false);
	assert.equal(isSafeNext("javascript:alert(1)"), false);
});

test("rejects backslash variants the URL parser normalizes to //", () => {
	assert.equal(isSafeNext("/\\evil.com"), false);
	assert.equal(isSafeNext("\\/evil.com"), false);
	assert.equal(isSafeNext("\\\\evil.com"), false);
});

test("rejects control characters that collapse into a protocol-relative URL", () => {
	assert.equal(isSafeNext("/\n/evil.com"), false);
	assert.equal(isSafeNext("/\t/evil.com"), false);
	assert.equal(isSafeNext("/\r/evil.com"), false);
	assert.equal(isSafeNext("/\u0000"), false);
	assert.equal(isSafeNext("/\u009f"), false);
});

test("rejects non-string and empty inputs", () => {
	assert.equal(isSafeNext(null), false);
	assert.equal(isSafeNext(undefined), false);
	assert.equal(isSafeNext(""), false);
	assert.equal(isSafeNext("agents"), false);
});

test("safeNext falls back for unsafe paths and passes safe ones through", () => {
	assert.equal(safeNext("/inbox"), "/inbox");
	assert.equal(safeNext("//evil.com"), "/");
	assert.equal(safeNext(null), "/");
	assert.equal(safeNext(undefined, "/onboarding"), "/onboarding");
});

test("tenantNext rejects operator control-plane paths", () => {
	assert.equal(tenantNext("/operator"), "/");
	assert.equal(tenantNext("/operator/status"), "/");
	assert.equal(tenantNext("/operator-login"), "/");
	assert.equal(tenantNext("/organization"), "/organization");
	assert.equal(tenantNext("/resources?filter=owned"), "/resources?filter=owned");
});

interface WindowStub {
	location: { pathname: string; search: string };
}

function withWindow<T>(pathname: string, search: string, fn: () => T): T {
	(globalThis as unknown as { window: WindowStub }).window = { location: { pathname, search } };
	try {
		return fn();
	} finally {
		delete (globalThis as { window?: WindowStub }).window;
	}
}

function withLocation<T>(loc: Record<string, string>, fn: () => T): T {
	(globalThis as unknown as { window: { location: Record<string, string> } }).window = { location: loc };
	try {
		return fn();
	} finally {
		delete (globalThis as { window?: unknown }).window;
	}
}

test("canonical login url is always the bare /login, relative on the base host, absolute off an org subdomain", () => {
	assert.equal(
		withLocation({ hostname: "localhost", host: "localhost:8000", port: "8000", protocol: "http:" }, () =>
			canonicalLoginUrl(),
		),
		"/login",
	);
	assert.equal(
		withLocation({ hostname: "lynx-capital.localhost", host: "lynx-capital.localhost:8000", port: "8000", protocol: "http:" }, () =>
			canonicalLoginUrl(),
		),
		"http://localhost:8000/login",
	);
});

test("currentPathAsNext is undefined outside a browser", () => {
	assert.equal(currentPathAsNext(), undefined);
});

test("currentPathAsNext skips home and auth pages that would loop", () => {
	assert.equal(withWindow("/", "", currentPathAsNext), undefined);
	assert.equal(withWindow("/login", "?next=%2Finbox", currentPathAsNext), undefined);
	assert.equal(withWindow("/operator-login", "", currentPathAsNext), undefined);
	assert.equal(withWindow("/register", "", currentPathAsNext), undefined);
	assert.equal(withWindow("/device", "?code=abc", currentPathAsNext), undefined);
});

test("currentPathAsNext skips operator paths", () => {
	assert.equal(withWindow("/operator", "", currentPathAsNext), undefined);
	assert.equal(withWindow("/operator/status", "?force=true", currentPathAsNext), undefined);
});

test("currentPathAsNext returns the current path with its query", () => {
	assert.equal(withWindow("/traces", "?range=7d", currentPathAsNext), "/traces?range=7d");
	assert.equal(withWindow("/inbox", "", currentPathAsNext), "/inbox");
});

test("session-expired login URL is the bare /login, and routes operator surfaces to their console", () => {
	assert.equal(
		withLocation({ hostname: "localhost", host: "localhost:8000", port: "8000", protocol: "http:", pathname: "/agents" }, sessionExpiredLoginUrl),
		"/login",
	);
	assert.equal(
		withLocation({ hostname: "localhost", host: "localhost:8000", port: "8000", protocol: "http:", pathname: "/" }, sessionExpiredLoginUrl),
		"/login",
	);
	assert.equal(
		withLocation({ hostname: "localhost", host: "localhost:8000", port: "8000", protocol: "http:", pathname: "/operator" }, sessionExpiredLoginUrl),
		"/operator-login",
	);
	assert.equal(
		withLocation({ hostname: "localhost", host: "localhost:8000", port: "8000", protocol: "http:", pathname: "/operator/status" }, sessionExpiredLoginUrl),
		"/operator-login",
	);
});
