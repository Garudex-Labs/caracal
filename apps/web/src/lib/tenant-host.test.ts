// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalAuthOrigin,
	canonicalAuthUrl,
	canonicalProjectFreePath,
	configureOrgSubdomains,
	firstSegmentsFromPaths,
	getTenant,
	initTenant,
	isAuthPath,
	isProjectFreePath,
	orgOrigin,
	orgSlugFromHost,
	pathWithoutProjectPrefix,
	projectSlugFromPath,
	projectRoutePath,
	projectEntryPath,
	supportsOrgSubdomains,
} from "./tenant-host.ts";

test("plain dev hosts carry no organization", () => {
	assert.equal(orgSlugFromHost("localhost"), null);
	assert.equal(orgSlugFromHost("127.0.0.1"), null);
});

test("org subdomain resolves on dev and production hosts", () => {
	assert.equal(orgSlugFromHost("acme.localhost"), "acme");
	assert.equal(orgSlugFromHost("ACME.localhost"), "acme");
	assert.equal(orgSlugFromHost("acme.caracal.example.com"), "acme");
});

test("infrastructure subdomains are never an organization", () => {
	for (const label of ["www", "api", "app", "sso", "auth", "cdn", "static"]) {
		assert.equal(orgSlugFromHost(`${label}.localhost`), null, label);
		assert.equal(orgSlugFromHost(`${label}.caracal.example.com`), null, label);
	}
});

test("apex and malformed hosts carry no organization", () => {
	assert.equal(orgSlugFromHost("example.com"), null);
	assert.equal(orgSlugFromHost(".localhost"), null);
	assert.equal(orgSlugFromHost("a.b.localhost"), null);
});

test("subdomain support tracks the host family when the deployment enables it", () => {
	configureOrgSubdomains(true);
	assert.equal(supportsOrgSubdomains("localhost"), true);
	assert.equal(supportsOrgSubdomains("acme.localhost"), true);
	assert.equal(supportsOrgSubdomains("acme.caracal.example.com"), true);
	assert.equal(supportsOrgSubdomains("example.com"), false);
	assert.equal(supportsOrgSubdomains("127.0.0.1"), false);
	// A single-host deployment (no base domain) never crosses to a subdomain.
	configureOrgSubdomains(false);
	assert.equal(supportsOrgSubdomains("localhost"), false);
	assert.equal(supportsOrgSubdomains("acme.caracal.example.com"), false);
});

test("org origin preserves protocol and port on dev hosts", () => {
	const loc = { hostname: "localhost", port: "5173", protocol: "http:" };
	assert.equal(orgOrigin("acme", loc), "http://acme.localhost:5173");
});

test("org origin swaps the org label instead of stacking a second one", () => {
	const dev = { hostname: "acme.localhost", port: "5173", protocol: "http:" };
	assert.equal(orgOrigin("beta", dev), "http://beta.localhost:5173");
	const prod = { hostname: "acme.caracal.example.com", port: "", protocol: "https:" };
	assert.equal(orgOrigin("beta", prod), "https://beta.caracal.example.com");
});

test("org origin keeps the full apex when no org label is present", () => {
	const loc = { hostname: "example.com", port: "", protocol: "https:" };
	assert.equal(orgOrigin("acme", loc), "https://acme.example.com");
});

test("reserved segments come from route paths, skipping params", () => {
	const reserved = firstSegmentsFromPaths(["/agents/$agentId", "/Settings/profile", "/$orgSlug", "/"]);
	assert.deepEqual([...reserved].sort(), ["agents", "settings"]);
});

test("first path segment is a project slug only when it is not a route", () => {
	const reserved = new Set(["agents", "settings"]);
	assert.equal(projectSlugFromPath("/checkout/traces", reserved), "checkout");
	assert.equal(projectSlugFromPath("/Checkout", reserved), "checkout");
	assert.equal(projectSlugFromPath("/agents/123", reserved), null);
	assert.equal(projectSlugFromPath("/", reserved), null);
});

test("project prefix strips cleanly from in-app paths", () => {
	assert.equal(pathWithoutProjectPrefix("/checkout/traces", "checkout"), "/traces");
	assert.equal(pathWithoutProjectPrefix("/checkout", "checkout"), "/");
	assert.equal(pathWithoutProjectPrefix("/checkout-plus/traces", "checkout"), "/checkout-plus/traces");
	assert.equal(pathWithoutProjectPrefix("/traces", null), "/traces");
	assert.equal(pathWithoutProjectPrefix("", null), "/");
});

test("org- and account-scoped surfaces are project-free", () => {
	assert.equal(isProjectFreePath("/organization"), true);
	assert.equal(isProjectFreePath("/organization/members"), true);
	assert.equal(isProjectFreePath("/Settings/profile"), true);
	assert.equal(isProjectFreePath("/onboarding"), true);
	assert.equal(isProjectFreePath("/operator"), true);
	assert.equal(isProjectFreePath("/organizations"), false);
	assert.equal(isProjectFreePath("/traces"), false);
});

test("prefixed organization and account routes canonicalize outside project context", () => {
	assert.equal(canonicalProjectFreePath("/platform/settings/security", "platform"), "/settings/security");
	assert.equal(canonicalProjectFreePath("/platform/organization/projects", "platform"), "/organization/projects");
	assert.equal(canonicalProjectFreePath("/platform/operator/status", "platform"), "/operator/status");
	assert.equal(canonicalProjectFreePath("/platform/onboarding/project", "platform"), "/onboarding/project");
	assert.equal(canonicalProjectFreePath("/platform/resources", "platform"), null);
	assert.equal(canonicalProjectFreePath("/settings/security", null), null);
});

test("project-facing links always include the validated project prefix", () => {
	assert.equal(projectRoutePath("platform", "/"), "/platform/");
	assert.equal(projectRoutePath("platform", "/resources"), "/platform/resources");
	assert.equal(projectRoutePath("platform", "traces/s1"), "/platform/traces/s1");
});

test("auth return paths are rebuilt under the newly authorized project", () => {
	assert.equal(projectEntryPath("platform", "/resources"), "/platform/resources");
	assert.equal(projectEntryPath("platform", "/old-project/traces/s1?view=raw"), "/platform/traces/s1?view=raw");
	assert.equal(projectEntryPath("platform", "/platform/agents/a1"), "/platform/agents/a1");
	assert.equal(projectEntryPath("platform", "/settings/security"), "/settings/security");
	assert.equal(projectEntryPath("platform", "/"), "/platform/");
});

test("initTenant resolves host org and project prefix together", () => {
	const reserved = new Set(["agents", "settings"]);
	const resolved = initTenant(reserved, { hostname: "acme.localhost", pathname: "/checkout/traces" });
	assert.deepEqual(resolved, { hostOrg: "acme", urlProject: "checkout" });
	assert.deepEqual(getTenant(), resolved);
});

test("initTenant resolves the project prefix on a plain host too (single-host mode)", () => {
	const reserved = new Set(["agents", "settings"]);
	// No org subdomain, but the project is still the first path segment: the
	// org comes from the session and the project stays mandatory in the URL.
	const resolved = initTenant(reserved, { hostname: "localhost", pathname: "/checkout/traces" });
	assert.deepEqual(resolved, { hostOrg: null, urlProject: "checkout" });
});

test("initTenant assigns no project when the first segment is a route", () => {
	const reserved = new Set(["agents", "settings"]);
	assert.deepEqual(initTenant(reserved, { hostname: "localhost", pathname: "/settings/profile" }), {
		hostOrg: null,
		urlProject: null,
	});
	assert.deepEqual(initTenant(reserved, { hostname: "acme.localhost", pathname: "/" }), {
		hostOrg: "acme",
		urlProject: null,
	});
});

test("auth paths are recognised; project routes and look-alikes are not", () => {
	assert.equal(isAuthPath("/login"), true);
	assert.equal(isAuthPath("/register"), true);
	assert.equal(isAuthPath("/device"), true);
	assert.equal(isAuthPath("/operator-login"), true);
	assert.equal(isAuthPath("/resources"), false);
	assert.equal(isAuthPath("/logins"), false);
});

test("canonical auth origin strips an org label in the host to reach the base host", () => {
	assert.equal(canonicalAuthOrigin({ hostname: "lynx-capital.localhost", port: "8000", protocol: "http:" }), "http://localhost:8000");
	assert.equal(canonicalAuthOrigin({ hostname: "acme.caracal.example.com", port: "", protocol: "https:" }), "https://caracal.example.com");
	// Base/apex and generic-subdomain hosts carry no org label: unchanged. The
	// decision is host-based, so it does not depend on the deployment flag.
	assert.equal(canonicalAuthOrigin({ hostname: "localhost", port: "8000", protocol: "http:" }), "http://localhost:8000");
	assert.equal(canonicalAuthOrigin({ hostname: "example.com", port: "", protocol: "https:" }), "https://example.com");
	assert.equal(canonicalAuthOrigin({ hostname: "app.caracal.example.com", port: "", protocol: "https:" }), "https://app.caracal.example.com");
});

test("canonical auth url escapes an org subdomain and drops the project prefix", () => {
	configureOrgSubdomains(true);
	const onOrgHost = {
		hostname: "lynx-capital.localhost",
		host: "lynx-capital.localhost:8000",
		port: "8000",
		protocol: "http:",
		pathname: "/lynx-capital/login",
		search: "?next=%2Flynx-capital%2Fresources",
		hash: "",
	};
	assert.equal(canonicalAuthUrl(onOrgHost, "lynx-capital"), "http://localhost:8000/login?next=%2Flynx-capital%2Fresources");
	// Already canonical: no redirect.
	const canonical = { hostname: "localhost", host: "localhost:8000", port: "8000", protocol: "http:", pathname: "/login", search: "", hash: "" };
	assert.equal(canonicalAuthUrl(canonical, null), null);
	// Non-auth project route: never treated as an auth surface.
	assert.equal(canonicalAuthUrl({ ...onOrgHost, pathname: "/lynx-capital/resources" }, "lynx-capital"), null);
	configureOrgSubdomains(false);
});
