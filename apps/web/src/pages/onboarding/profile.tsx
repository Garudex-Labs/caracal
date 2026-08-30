// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Onboarding stage 1: the application profile. Identity (the account) is
// already established by the identity service; this stage configures how the
// user appears - avatar, display name, and the registry username that doubles
// as their publishing namespace. Fields persist individually, so partial
// completion survives a refresh; Continue stamps completion server-side.

import { useCallback, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { auth, getUserAvatar, onboarding, setUserName, setUserUsername } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useInvalidateOnboarding, useOnboardingStage } from "@/hooks/use-onboarding";
import { NAMESPACE_RULE_TEXT, isValidNamespace } from "@/lib/registry-name";
import { AvatarEditable } from "@/components/account/avatar-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StageHeader, StagePending } from "@/pages/onboarding/shell";

function subscribeStorage(cb: () => void) {
	window.addEventListener("storage", cb);
	return () => window.removeEventListener("storage", cb);
}

const FIELD_HINT = "mt-1.5 text-xs leading-5 text-muted-foreground";

export default function OnboardingProfilePage() {
	const { snapshot, ready } = useOnboardingStage("profile");
	if (!ready || !snapshot) return <StagePending />;
	return <ProfileForm key={snapshot.profile.username} />;
}

function ProfileForm() {
	const { snapshot } = useOnboardingStage("profile");
	const navigate = useNavigate();
	const invalidate = useInvalidateOnboarding();
	const queryClient = useQueryClient();
	const profile = snapshot!.profile;

	const [name, setName] = useState(profile.name);
	const [username, setUsername] = useState(profile.username);
	const [savedName, setSavedName] = useState(profile.name);
	const [savedUsername, setSavedUsername] = useState(profile.username);
	const [submitting, setSubmitting] = useState(false);
	// The avatar saves itself through AvatarEditable; mirror its cache updates.
	const cachedAvatar = useSyncExternalStore(subscribeStorage, getUserAvatar, () => null);
	const avatarUrl = cachedAvatar ?? profile.avatar_url ?? null;

	const nameValid = name.trim().length > 0 && name.trim().length <= 100;
	const usernameValid = isValidNamespace(username);

	// Each field persists on its own, so a refresh mid-setup loses nothing.
	const persistName = useCallback(async () => {
		const value = name.trim();
		if (!value || value === savedName) return;
		const { error } = await authClient.updateUser({ name: value });
		if (error) throw new Error(error.message || "Failed to update name");
		setUserName(value);
		setSavedName(value);
		window.dispatchEvent(new Event("storage"));
	}, [name, savedName]);

	const persistUsername = useCallback(async () => {
		const value = username.trim();
		if (!value || value === savedUsername) return;
		const data = await auth.updateUsername({ username: value });
		setUserUsername(data.username);
		setSavedUsername(data.username);
		queryClient.setQueryData(
			["auth", "whoami"],
			(prev: { username?: string | null } | undefined) =>
				prev ? { ...prev, username: data.username } : prev,
		);
		queryClient.invalidateQueries({ queryKey: ["auth", "whoami"] });
		window.dispatchEvent(new Event("storage"));
	}, [username, savedUsername, queryClient]);

	const saveField = useCallback(
		async (persist: () => Promise<void>) => {
			try {
				await persist();
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Failed to save");
			}
		},
		[],
	);

	async function handleContinue() {
		if (!nameValid || !usernameValid) return;
		setSubmitting(true);
		try {
			await persistName();
			await persistUsername();
			await onboarding.completeProfile();
			invalidate();
			navigate({ to: "/onboarding/organization", search: (prev) => prev });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to complete profile");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="space-y-10">
			<StageHeader
				kicker="Step 1 · Profile"
				title="Set up your profile"
				description="You're signed in - now decide how you appear in traces, reviews, and the registry. Everything here can be changed later in Settings."
			/>

			<section className="space-y-8">
				<div className="flex items-center gap-5 border-b border-border pb-8">
					<AvatarEditable name={name || profile.email} avatarUrl={avatarUrl} />
					<div>
						<p className="text-sm font-medium">Avatar</p>
						<p className="mt-0.5 max-w-xs text-xs leading-5 text-muted-foreground">
							Optional. Shown in the top bar, reviews, and rosters. PNG, JPEG, or WebP up to 2 MB.
						</p>
					</div>
				</div>

				<div>
					<Label htmlFor="onboarding-name" className="text-sm font-medium">
						Display name
					</Label>
					<Input
						id="onboarding-name"
						value={name}
						maxLength={100}
						autoComplete="name"
						placeholder="Richard Hendricks"
						onChange={(e) => setName(e.target.value)}
						onBlur={() => nameValid && saveField(persistName)}
						className="mt-2 h-10"
						aria-invalid={!nameValid}
					/>
					<p className={FIELD_HINT}>How teammates see you across the workspace.</p>
				</div>

				<div>
					<Label htmlFor="onboarding-username" className="text-sm font-medium">
						Username
					</Label>
					<Input
						id="onboarding-username"
						value={username}
						autoComplete="off"
						spellCheck={false}
						placeholder="richard-hendricks"
						onChange={(e) => setUsername(e.target.value.toLowerCase())}
						onBlur={() => usernameValid && saveField(persistUsername)}
						className="mt-2 h-10 font-mono"
						aria-invalid={!usernameValid}
					/>
					<p className={FIELD_HINT}>
						Your registry namespace - anything you publish is addressed as{" "}
						<span className="font-mono text-foreground/80">{usernameValid ? username : "username"}/name</span>.{" "}
						{NAMESPACE_RULE_TEXT}.
					</p>
				</div>

				<div>
					<Label className="text-sm font-medium">Email</Label>
					<p className="mt-2 font-mono text-sm text-muted-foreground">{profile.email}</p>
					<p className={FIELD_HINT}>Your sign-in identity, managed by the identity provider.</p>
				</div>
			</section>

			<footer className="flex items-center justify-between border-t border-border pt-6">
				<p className="text-xs text-muted-foreground">Your changes save as you go.</p>
				<Button onClick={handleContinue} disabled={!nameValid || !usernameValid || submitting} className="h-10 px-5">
					{submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
					Continue
					<ArrowRight className="ml-1.5 h-4 w-4" />
				</Button>
			</footer>
		</div>
	);
}
