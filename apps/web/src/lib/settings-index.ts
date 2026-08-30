// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for the settings information architecture.
// The settings layout nav, the /settings directory, the settings search,
// and the global command menu all render from this index so the four
// surfaces can never drift apart.

import {
	CircleUser,
	KeyRound,
	ShieldCheck,
	SlidersHorizontal,
	type LucideIcon,
} from "lucide-react";
import { hasMinRole, type Role } from "@/hooks/use-role-guard";

/** Who a settings group affects. Drives grouping, badges, and copy. */
export type SettingsScope = "account" | "organization" | "instance";

export interface SettingsGroupDef {
	scope: SettingsScope;
	/** Group heading in the nav and directory. */
	label: string;
	/** One-line explanation of the scope boundary. */
	description: string;
}

export interface SettingsSectionDef {
	id: string;
	title: string;
	/** Contextual one-liner shown in nav tooltips, directory rows, and search. */
	description: string;
	to: string;
	icon: LucideIcon;
	scope: SettingsScope;
	/** Minimum role required to see and use the section. */
	minRole: Role;
}

export interface SettingsSearchEntry {
	/** Individual setting or action inside a section. */
	title: string;
	sectionId: string;
	/** Anchor id of the target section element on the page. */
	hash?: string;
	keywords: string[];
}

export const SETTINGS_GROUPS: SettingsGroupDef[] = [
	{
		scope: "account",
		label: "Account",
		description: "Applies only to you, on every device you sign in from.",
	},
	{
		scope: "organization",
		label: "Organization",
		description: "Organizations, projects, people, and sign-in identity for everyone on this instance.",
	},
	{
		scope: "instance",
		label: "Instance",
		description: "Deployment-wide server configuration. Changes affect all users.",
	},
];

export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
	{
		id: "profile",
		title: "Profile",
		description: "Your identity: avatar, display name, email, and registry username.",
		to: "/settings/profile",
		icon: CircleUser,
		scope: "account",
		minRole: "user",
	},
	{
		id: "security",
		title: "Security",
		description: "Password, passkeys, and active sessions.",
		to: "/settings/security",
		icon: ShieldCheck,
		scope: "account",
		minRole: "user",
	},
	{
		id: "preferences",
		title: "Preferences",
		description: "Theme, interface behavior, and project resource retention.",
		to: "/settings/preferences",
		icon: SlidersHorizontal,
		scope: "account",
		minRole: "user",
	},
	{
		id: "sso",
		title: "Single Sign-On",
		description: "OIDC and SAML identity providers resolved by email domain.",
		to: "/settings/sso",
		icon: KeyRound,
		scope: "organization",
		minRole: "operator",
	},
];

// Deep links to individual settings. Section-level keywords live on the
// section itself; these entries exist so search lands on the exact control.
export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
	{ title: "Avatar & display name", sectionId: "profile", hash: "identity", keywords: ["photo", "picture", "name", "email"] },
	{ title: "Username", sectionId: "profile", hash: "username", keywords: ["handle", "namespace", "publish", "rename"] },
	{ title: "Change password", sectionId: "security", hash: "password", keywords: ["credentials", "rotate"] },
	{ title: "Passkeys", sectionId: "security", hash: "passkeys", keywords: ["webauthn", "fido", "biometric", "security key"] },
	{ title: "Active sessions", sectionId: "security", hash: "sessions", keywords: ["devices", "sign out", "revoke", "logout"] },
	{ title: "Theme", sectionId: "preferences", hash: "theme", keywords: ["dark", "light", "appearance", "color"] },
	{ title: "Resource deletion", sectionId: "preferences", hash: "resource-retention", keywords: ["deleted", "restore", "purge", "retention"] },
	{ title: "Identity providers", sectionId: "sso", hash: "providers", keywords: ["saml", "oidc", "okta", "azure", "entra", "domain"] },
];

export function sectionById(id: string): SettingsSectionDef | undefined {
	return SETTINGS_SECTIONS.find((s) => s.id === id);
}

/** Sections the given role may open. `role` is the cached role string. */
export function visibleSettingsSections(role: string | null): SettingsSectionDef[] {
	return SETTINGS_SECTIONS.filter((s) => hasMinRole(role, s.minRole));
}

export function scopeLabel(scope: SettingsScope): string {
	return SETTINGS_GROUPS.find((g) => g.scope === scope)?.label ?? scope;
}
