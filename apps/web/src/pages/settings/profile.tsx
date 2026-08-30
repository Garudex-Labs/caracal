// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Personal identity: avatar, display name, email, role, and the registry
// username that doubles as the publishing namespace.

import { useCallback, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
	auth,
	getUserAvatar,
	getUserEmail,
	getUserName,
	getUserRole,
	getUserUsername,
	setUserName,
	setUserUsername,
} from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { ROLE_LABELS, type Role } from "@/hooks/use-role-guard";
import { NAMESPACE_RULE_TEXT, isValidNamespace } from "@/lib/registry-name";
import { AvatarEditable } from "@/components/account/avatar-upload";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	SettingRow,
	SettingsCard,
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-shell";

function subscribe(cb: () => void) {
	window.addEventListener("storage", cb);
	return () => window.removeEventListener("storage", cb);
}

function useProfileSnapshot() {
	return useSyncExternalStore(
		subscribe,
		() =>
			JSON.stringify({
				name: getUserName() ?? "",
				email: getUserEmail() ?? "",
				role: getUserRole() ?? "",
				username: getUserUsername() ?? "",
				avatar: getUserAvatar(),
			}),
		() => JSON.stringify({ name: "", email: "", role: "", username: "", avatar: null }),
	);
}

// ── Display name ────────────────────────────────────────────────────────────

function DisplayNameControl({ currentName }: { currentName: string }) {
	const [draft, setDraft] = useState(currentName);
	const [saving, setSaving] = useState(false);
	const dirty = draft.trim() !== currentName && draft.trim().length > 0;

	const save = useCallback(async () => {
		const name = draft.trim();
		if (!name) return;
		setSaving(true);
		try {
			const { error } = await authClient.updateUser({ name });
			if (error) throw new Error(error.message || "Failed to update name");
			setUserName(name);
			window.dispatchEvent(new Event("storage"));
			toast.success("Display name updated");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update name");
		} finally {
			setSaving(false);
		}
	}, [draft]);

	return (
		<div className="flex w-full max-w-sm items-center gap-2">
			<Input
				id="display-name"
				value={draft}
				maxLength={100}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && dirty) save();
				}}
				className="h-8 text-sm"
			/>
			<Button size="sm" className="h-8" onClick={save} disabled={!dirty || saving}>
				{saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
				Save
			</Button>
		</div>
	);
}

// ── Username ────────────────────────────────────────────────────────────────

function UsernameSection({ currentUsername }: { currentUsername: string }) {
	const [newUsername, setNewUsername] = useState("");
	const [saving, setSaving] = useState(false);
	const queryClient = useQueryClient();

	// A username that is not a valid namespace predates namespace validation.
	// Publishing rejects it, so surface why rather than letting them find out
	// at submit time.
	const namespaceInvalid = !!currentUsername && !isValidNamespace(currentUsername);

	const handleSubmit = useCallback(async () => {
		if (!newUsername.trim()) {
			toast.error("Username cannot be empty");
			return;
		}
		if (newUsername.length < 3 || newUsername.length > 32) {
			toast.error("Username must be 3–32 characters");
			return;
		}
		if (!isValidNamespace(newUsername)) {
			toast.error(NAMESPACE_RULE_TEXT);
			return;
		}
		if (newUsername === currentUsername) {
			toast.error("New username is the same as current username");
			return;
		}
		setSaving(true);
		try {
			const data = await auth.updateUsername({ username: newUsername });
			setUserUsername(data.username);
			// Registry-facing UI (submit dialogs, the agent builder, resource
			// detail) reads the handle from the cached whoami query, so refresh
			// it too - otherwise the new namespace only appears after a reload.
			queryClient.setQueryData(
				["auth", "whoami"],
				(prev: { username?: string | null } | undefined) =>
					prev ? { ...prev, username: data.username } : prev,
			);
			queryClient.invalidateQueries({ queryKey: ["auth", "whoami"] });
			window.dispatchEvent(new Event("storage"));
			toast.success("Username updated");
			setNewUsername("");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update username");
		} finally {
			setSaving(false);
		}
	}, [newUsername, currentUsername, queryClient]);

	return (
		<SettingsSection
			id="username"
			title="Username"
			description="Your registry namespace. Agents and components you publish are addressed as username/name."
		>
			<SettingsCard>
				{namespaceInvalid && (
					<div className="flex items-start gap-2 px-4 py-3 text-warning">
						<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<p className="text-xs leading-5">
							<span className="font-medium">@{currentUsername}</span> cannot be used as a registry
							namespace, so publishing is blocked. Choose a valid username below - anything you
							already published moves with you.
						</p>
					</div>
				)}
				<SettingRow label="Current username">
					<span className="font-mono text-sm text-muted-foreground">
						{currentUsername ? `@${currentUsername}` : "–"}
					</span>
				</SettingRow>
				<SettingRow
					label="New username"
					description={`${NAMESPACE_RULE_TEXT}.`}
					htmlFor="new-username"
					stacked
				>
					<div className="flex w-full max-w-sm items-center gap-2">
						<Input
							id="new-username"
							value={newUsername}
							onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
							placeholder="3–32 chars, lowercase alphanumeric + hyphens/dots"
							className="h-8 text-sm"
							onKeyDown={(e) => {
								if (e.key === "Enter") handleSubmit();
							}}
						/>
						<Button
							size="sm"
							className="h-8"
							onClick={handleSubmit}
							disabled={saving || !newUsername.trim() || newUsername === currentUsername}
						>
							{saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
							Update
						</Button>
					</div>
				</SettingRow>
			</SettingsCard>
		</SettingsSection>
	);
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function ProfileSettingsPage() {
	const snapshot = useProfileSnapshot();
	const { name, email, role, username, avatar } = JSON.parse(snapshot) as {
		name: string;
		email: string;
		role: string;
		username: string;
		avatar: string | null;
	};
	const roleLabel = role ? (ROLE_LABELS[role as Role] ?? role) : "–";

	return (
		<SettingsPage
			title="Profile"
			description="How you appear across the registry, traces, and reviews."
			scope="account"
		>
			<SettingsSection id="identity" title="Identity">
				<SettingsCard>
					<SettingRow
						label="Avatar"
						description="Shown in the top bar, reviews, and project rosters."
					>
						<AvatarEditable name={name || "–"} avatarUrl={avatar} />
					</SettingRow>
					<SettingRow label="Display name" htmlFor="display-name" stacked>
						<DisplayNameControl key={name} currentName={name} />
					</SettingRow>
					<SettingRow
						label="Email"
						description="Your sign-in identity. Managed by the identity provider."
					>
						<span className="font-mono text-sm text-muted-foreground">{email || "–"}</span>
					</SettingRow>
					<SettingRow
						label="Role"
						description="Instance-wide permission level, assigned by an administrator."
					>
						<Badge variant="secondary" className="text-xs">
							{roleLabel}
						</Badge>
					</SettingRow>
				</SettingsCard>
			</SettingsSection>

			<UsernameSection currentUsername={username} />
		</SettingsPage>
	);
}
