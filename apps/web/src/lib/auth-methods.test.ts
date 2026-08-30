// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	accountPasswordState,
	authPageState,
	availableMethods,
	primaryMethod,
	providerLabel,
	type AuthCapabilitySnapshot,
	type LinkedAccount,
} from "./auth-methods.ts";

const BASE: AuthCapabilitySnapshot = {
	loading: false,
	fetchFailed: false,
	authAvailable: true,
	emailPassword: false,
	magicLinks: false,
	google: false,
	github: false,
	sso: false,
	passkeys: false,
	devLogin: false,
};

test("loading state advertises nothing", () => {
	const c = { ...BASE, loading: true, emailPassword: true };
	assert.equal(authPageState(c), "loading");
	assert.deepEqual(availableMethods(c), []);
});

test("failed capability fetch fails safely", () => {
	const c = { ...BASE, fetchFailed: true, emailPassword: true, google: true };
	assert.equal(authPageState(c), "unavailable");
	assert.deepEqual(availableMethods(c), []);
	assert.equal(primaryMethod(c), null);
});

test("unreachable identity service is unavailable, not unconfigured", () => {
	const c = { ...BASE, authAvailable: false, emailPassword: true };
	assert.equal(authPageState(c), "unavailable");
	assert.deepEqual(availableMethods(c), []);
});

test("no configured methods renders the setup state", () => {
	assert.equal(authPageState(BASE), "unconfigured");
});

test("credentials only", () => {
	const c = { ...BASE, emailPassword: true };
	assert.equal(authPageState(c), "ready");
	assert.deepEqual(availableMethods(c), ["password"]);
	assert.equal(primaryMethod(c), "password");
});

test("passwordless only promotes the magic link to primary", () => {
	const c = { ...BASE, magicLinks: true };
	assert.deepEqual(availableMethods(c), ["magic-link"]);
	assert.equal(primaryMethod(c), "magic-link");
});

test("social providers listed after credentials", () => {
	const c = { ...BASE, emailPassword: true, google: true, github: true };
	assert.deepEqual(availableMethods(c), ["password", "google", "github"]);
	assert.equal(primaryMethod(c), "password");
});

test("sso-only deployments promote sso to primary", () => {
	const c = { ...BASE, sso: true };
	assert.deepEqual(availableMethods(c), ["sso"]);
	assert.equal(primaryMethod(c), "sso");
});

test("passkeys appear as an alternative, never primary alongside credentials", () => {
	const c = { ...BASE, emailPassword: true, passkeys: true };
	assert.deepEqual(availableMethods(c), ["password", "passkey"]);
});

test("everything configured keeps password primary and stable order", () => {
	const c = {
		...BASE,
		emailPassword: true,
		magicLinks: true,
		google: true,
		github: true,
		sso: true,
		passkeys: true,
		devLogin: true,
	};
	assert.equal(authPageState(c), "ready");
	assert.deepEqual(availableMethods(c), ["password", "magic-link", "google", "github", "sso", "passkey", "dev"]);
	assert.equal(primaryMethod(c), "password");
});

test("dev login alone still renders a usable page", () => {
	const c = { ...BASE, devLogin: true };
	assert.equal(authPageState(c), "ready");
	assert.deepEqual(availableMethods(c), ["dev"]);
});

// ── Per-account credential state ────────────────────────────────────────────

const acct = (providerId: string): LinkedAccount => ({ providerId, id: `id-${providerId}` });

test("password-only user has a local credential and no external providers", () => {
	const s = accountPasswordState([acct("credential")]);
	assert.equal(s.hasPassword, true);
	assert.deepEqual(s.externalProviders, []);
});

test("google-only user has no local credential", () => {
	const s = accountPasswordState([acct("google")]);
	assert.equal(s.hasPassword, false);
	assert.deepEqual(s.externalProviders.map((p) => p.providerId), ["google"]);
});

test("github-only user has no local credential", () => {
	const s = accountPasswordState([acct("github")]);
	assert.equal(s.hasPassword, false);
	assert.deepEqual(s.externalProviders.map((p) => p.providerId), ["github"]);
});

test("sso-only user has no local credential", () => {
	const s = accountPasswordState([acct("okta-corp")]);
	assert.equal(s.hasPassword, false);
	assert.deepEqual(s.externalProviders.map((p) => p.providerId), ["okta-corp"]);
});

test("multiple external providers without a password expose none as a credential", () => {
	const s = accountPasswordState([acct("google"), acct("github")]);
	assert.equal(s.hasPassword, false);
	assert.deepEqual(s.externalProviders.map((p) => p.providerId), ["google", "github"]);
});

test("multiple providers plus a password still reports a local credential", () => {
	const s = accountPasswordState([acct("google"), acct("github"), acct("credential")]);
	assert.equal(s.hasPassword, true);
	assert.deepEqual(s.externalProviders.map((p) => p.providerId), ["google", "github"]);
});

test("empty account list fails safe to no credential", () => {
	const s = accountPasswordState([]);
	assert.equal(s.hasPassword, false);
	assert.deepEqual(s.externalProviders, []);
});

test("provider labels are humanized, unknown ids title-cased", () => {
	assert.equal(providerLabel("credential"), "Password");
	assert.equal(providerLabel("google"), "Google");
	assert.equal(providerLabel("github"), "GitHub");
	assert.equal(providerLabel("okta-corp"), "Okta Corp");
	assert.equal(providerLabel("entra_id"), "Entra Id");
});
