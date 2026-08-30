// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

export type AuthContext = "tenant" | "operator";

export const AUTH_CONTEXTS: AuthContext[] = ["tenant", "operator"];

const LEGACY_STORAGE_KEY_ACCESS_TOKEN = "caracal_access_token";
const STORAGE_KEY_ACCESS_TOKEN: Record<AuthContext, string> = {
	tenant: "caracal_tenant_access_token",
	operator: "caracal_operator_access_token",
};
const STORAGE_KEY_ACTIVE_CONTEXT: Record<AuthContext, string> = {
	tenant: "caracal_tenant_context_active",
	operator: "caracal_operator_context_active",
};
const STORAGE_KEY_USER_ROLE: Record<AuthContext, string> = {
	tenant: "caracal_tenant_user_role",
	operator: "caracal_operator_user_role",
};
const STORAGE_KEY_USER_NAME: Record<AuthContext, string> = {
	tenant: "caracal_tenant_user_name",
	operator: "caracal_operator_user_name",
};
const STORAGE_KEY_USER_EMAIL: Record<AuthContext, string> = {
	tenant: "caracal_tenant_user_email",
	operator: "caracal_operator_user_email",
};
const STORAGE_KEY_USER_USERNAME: Record<AuthContext, string> = {
	tenant: "caracal_tenant_user_username",
	operator: "caracal_operator_user_username",
};
const STORAGE_KEY_USER_AVATAR: Record<AuthContext, string> = {
	tenant: "caracal_tenant_user_avatar",
	operator: "caracal_operator_user_avatar",
};
const LEGACY_PROFILE_KEYS = [
	"caracal_user_role",
	"caracal_user_name",
	"caracal_user_email",
	"caracal_user_username",
	"caracal_user_avatar",
];

export function emitAuthChange() {
	if (typeof window !== "undefined") window.dispatchEvent(new Event("storage"));
}

export function tokenPayload(token: string): Record<string, unknown> | null {
	try {
		return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
	} catch {
		return null;
	}
}

export function tokenAuthContext(token: string): string | null {
	const context = tokenPayload(token)?.auth_context;
	return typeof context === "string" ? context : null;
}

export function authContextForPath(path: string): AuthContext {
	if (path === "/dashboard/tokens" || path.startsWith("/dashboard/tokens?")) return "tenant";
	return path.startsWith("/operator") ||
		path.startsWith("/exec") ||
		path.startsWith("/support") ||
		path === "/telemetry/status" ||
		path.startsWith("/dashboard/")
		? "operator"
		: "tenant";
}

export function activateAuthContext(context: AuthContext) {
	localStorage.setItem(STORAGE_KEY_ACTIVE_CONTEXT[context], "1");
	emitAuthChange();
}

export function hasActiveAuthContext(context: AuthContext): boolean {
	if (typeof window === "undefined") return false;
	return localStorage.getItem(STORAGE_KEY_ACTIVE_CONTEXT[context]) === "1";
}

export function getStoredAccessToken(context: AuthContext): string | null {
	if (typeof window === "undefined") return null;
	const token = sessionStorage.getItem(STORAGE_KEY_ACCESS_TOKEN[context]);
	if (!token) return null;
	if (tokenAuthContext(token) !== context) {
		sessionStorage.removeItem(STORAGE_KEY_ACCESS_TOKEN[context]);
		return null;
	}
	return token;
}

export function setStoredAccessToken(context: AuthContext, token: string) {
	sessionStorage.setItem(STORAGE_KEY_ACCESS_TOKEN[context], token);
}

export function clearStoredAuthContext(context: AuthContext) {
	sessionStorage.removeItem(STORAGE_KEY_ACCESS_TOKEN[context]);
	localStorage.removeItem(STORAGE_KEY_ACTIVE_CONTEXT[context]);
	localStorage.removeItem(STORAGE_KEY_USER_ROLE[context]);
	localStorage.removeItem(STORAGE_KEY_USER_NAME[context]);
	localStorage.removeItem(STORAGE_KEY_USER_EMAIL[context]);
	localStorage.removeItem(STORAGE_KEY_USER_USERNAME[context]);
	localStorage.removeItem(STORAGE_KEY_USER_AVATAR[context]);
	if (context === "tenant") {
		localStorage.removeItem("caracal_current_org");
		localStorage.removeItem("caracal_current_project");
	}
}

export function clearAllAuthContexts() {
	for (const context of AUTH_CONTEXTS) clearStoredAuthContext(context);
	sessionStorage.removeItem(LEGACY_STORAGE_KEY_ACCESS_TOKEN);
	localStorage.removeItem("caracal_refresh_token");
	localStorage.removeItem("caracal_api_key");
	for (const key of LEGACY_PROFILE_KEYS) localStorage.removeItem(key);
}

export function setStoredUserRole(role: string, context: AuthContext) {
	localStorage.setItem(STORAGE_KEY_USER_ROLE[context], role);
}

export function getStoredUserRole(context: AuthContext): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(STORAGE_KEY_USER_ROLE[context]);
}

export function setStoredUserName(name: string, context: AuthContext) {
	localStorage.setItem(STORAGE_KEY_USER_NAME[context], name);
}

export function getStoredUserName(context: AuthContext): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(STORAGE_KEY_USER_NAME[context]);
}

export function setStoredUserEmail(email: string, context: AuthContext) {
	localStorage.setItem(STORAGE_KEY_USER_EMAIL[context], email);
}

export function getStoredUserEmail(context: AuthContext): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(STORAGE_KEY_USER_EMAIL[context]);
}

export function setStoredUserUsername(username: string, context: AuthContext) {
	localStorage.setItem(STORAGE_KEY_USER_USERNAME[context], username);
}

export function getStoredUserUsername(context: AuthContext): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(STORAGE_KEY_USER_USERNAME[context]);
}

export function setStoredUserAvatar(avatar: string | null, context: AuthContext) {
	if (avatar) {
		localStorage.setItem(STORAGE_KEY_USER_AVATAR[context], avatar);
	} else {
		localStorage.removeItem(STORAGE_KEY_USER_AVATAR[context]);
	}
	emitAuthChange();
}

export function getStoredUserAvatar(context: AuthContext): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(STORAGE_KEY_USER_AVATAR[context]);
}
