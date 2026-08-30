// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side model of the deployment's sign-in capabilities. The auth
 * page renders exactly what this module derives from the server's
 * capability descriptor - registering a new provider means adding one
 * row to METHODS, not editing page components. Hiding a method here is
 * presentation only; the identity service enforces availability itself.
 */

export type AuthMethodId = "password" | "google" | "github" | "sso" | "passkey" | "magic-link" | "dev";

export type AuthCapabilitySnapshot = {
	/** The capability query has not resolved yet. */
	loading: boolean;
	/** The capability query failed; availability is unknown. */
	fetchFailed: boolean;
	/** The config API answered but the identity service did not. */
	authAvailable: boolean;
	emailPassword: boolean;
	magicLinks: boolean;
	google: boolean;
	github: boolean;
	sso: boolean;
	passkeys: boolean;
	devLogin: boolean;
};

export type AuthPageState = "loading" | "unavailable" | "unconfigured" | "ready";

// Presentation order: the first available entry is the primary path.
const METHODS: ReadonlyArray<{ id: AuthMethodId; available: (c: AuthCapabilitySnapshot) => boolean }> = [
	{ id: "password", available: (c) => c.emailPassword },
	{ id: "magic-link", available: (c) => c.magicLinks },
	{ id: "google", available: (c) => c.google },
	{ id: "github", available: (c) => c.github },
	{ id: "sso", available: (c) => c.sso },
	{ id: "passkey", available: (c) => c.passkeys },
	{ id: "dev", available: (c) => c.devLogin },
];

// Unknown availability never advertises methods: a failed or unanswered
// capability probe renders the unavailable state, not a guessed form.
export function authPageState(c: AuthCapabilitySnapshot): AuthPageState {
	if (c.loading) return "loading";
	if (c.fetchFailed || !c.authAvailable) return "unavailable";
	return availableMethods(c).length > 0 ? "ready" : "unconfigured";
}

export function availableMethods(c: AuthCapabilitySnapshot): AuthMethodId[] {
	if (c.loading || c.fetchFailed || !c.authAvailable) return [];
	return METHODS.filter((m) => m.available(c)).map((m) => m.id);
}

export function primaryMethod(c: AuthCapabilitySnapshot): AuthMethodId | null {
	return availableMethods(c)[0] ?? null;
}

// ── Per-account credential state ────────────────────────────────────────────

/**
 * A single authentication identity linked to the signed-in user, as returned
 * by Better Auth's `listAccounts`. Better Auth is the authoritative source:
 * the local email/password identity is the reserved `"credential"` provider,
 * every other value (google, github, an SSO provider id, …) is external.
 */
export type LinkedAccount = { providerId: string; accountId?: string; id?: string };

export type AccountPasswordState = {
	/** True iff a Better Auth `"credential"` account exists for the user. */
	hasPassword: boolean;
	/** Linked identities other than the local credential. */
	externalProviders: LinkedAccount[];
};

/**
 * Derive password-management capability from the user's real linked accounts.
 * Never infers state from the last login method or environment flags.
 */
export function accountPasswordState(accounts: LinkedAccount[]): AccountPasswordState {
	return {
		hasPassword: accounts.some((a) => a.providerId === "credential"),
		externalProviders: accounts.filter((a) => a.providerId !== "credential"),
	};
}

const PROVIDER_LABELS: Record<string, string> = {
	credential: "Password",
	google: "Google",
	github: "GitHub",
};

/** Human-readable name for a Better Auth `providerId`. */
export function providerLabel(providerId: string): string {
	return (
		PROVIDER_LABELS[providerId] ??
		providerId.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
	);
}
