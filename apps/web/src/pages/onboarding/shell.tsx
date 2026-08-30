// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Full-page onboarding chrome: a fixed context rail carrying the setup
// progression (Profile → Organization → Project) and the signed-in identity,
// with the active stage rendered in the content region. Rendered without the
// app shell because no valid org/project context exists yet.

import { useLocation, useRouter } from "@tanstack/react-router";
import { Check, LogOut } from "lucide-react";
import { clearSession, getUserAvatar, getUserEmail, getUserName } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STEPS = [
	{
		id: "profile",
		path: "/onboarding/profile",
		title: "Profile",
		description: "How you appear across the workspace",
	},
	{
		id: "organization",
		path: "/onboarding/organization",
		title: "Organization",
		description: "Create your own or join your team",
	},
	{
		id: "project",
		path: "/onboarding/project",
		title: "Project",
		description: "The working context you enter",
	},
] as const;

function initials(name: string) {
	return (
		name
			.split(" ")
			.map((w) => w[0])
			.join("")
			.toUpperCase()
			.slice(0, 2) || "?"
	);
}

function activeIndex(pathname: string): number {
	const at = STEPS.findIndex((s) => pathname === s.path || pathname.startsWith(`${s.path}/`));
	return at === -1 ? 0 : at;
}

function SignOutButton() {
	const router = useRouter();
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-8 shrink-0 px-2 text-muted-foreground hover:text-foreground"
			onClick={async () => {
				try {
					await authClient.signOut();
				} catch {
					// Best-effort - proceed with client-side cleanup regardless
				}
				clearSession();
				router.navigate({ to: "/login" });
			}}
		>
			<LogOut className="mr-1.5 h-3.5 w-3.5" />
			Sign out
		</Button>
	);
}

function IdentityChip() {
	const name = getUserName() || "Signed in";
	const email = getUserEmail() || "";
	const avatarUrl = getUserAvatar();
	return (
		<div className="flex min-w-0 items-center gap-2.5">
			<Avatar className="h-8 w-8 ring-1 ring-border">
				{avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
				<AvatarFallback className="bg-secondary text-[10px] font-medium">{initials(name)}</AvatarFallback>
			</Avatar>
			<div className="min-w-0">
				<p className="truncate text-xs font-medium">{name}</p>
				<p className="truncate text-[11px] text-muted-foreground">{email}</p>
			</div>
		</div>
	);
}

export function OnboardingShell({ children }: { children: React.ReactNode }) {
	const { pathname } = useLocation();
	const current = activeIndex(pathname);

	return (
		<div className="flex min-h-screen bg-background">
			{/* Context rail: where the user is in setup, and who they are. */}
			<aside className="hidden w-80 shrink-0 flex-col justify-between border-r border-border px-8 py-10 lg:flex xl:w-96">
				<div>
					<p className="text-sm font-semibold tracking-tight">Caracal</p>
					<p className="mt-1 text-xs text-muted-foreground">Workspace setup</p>
					<nav aria-label="Setup progress" className="mt-10">
						<ol className="space-y-6">
							{STEPS.map((step, i) => {
								const state = i < current ? "done" : i === current ? "current" : "upcoming";
								return (
									<li key={step.id} className="flex gap-3.5">
										<span
											aria-hidden
											className={cn(
												"mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
												state === "done" && "border-primary/50 bg-primary/15 text-primary",
												state === "current" && "border-primary bg-primary text-primary-foreground",
												state === "upcoming" && "border-border text-muted-foreground",
											)}
										>
											{state === "done" ? <Check className="h-3.5 w-3.5" /> : i + 1}
										</span>
										<span className="min-w-0">
											<span
												className={cn(
													"block text-sm font-medium",
													state === "current" ? "text-foreground" : "text-muted-foreground",
												)}
												aria-current={state === "current" ? "step" : undefined}
											>
												{step.title}
											</span>
											<span className="mt-0.5 block text-xs leading-5 text-muted-foreground/80">
												{step.description}
											</span>
										</span>
									</li>
								);
							})}
						</ol>
					</nav>
				</div>
				<div className="border-t border-border pt-5">
					<IdentityChip />
				</div>
			</aside>

			{/* Stage content. */}
			<div className="flex min-w-0 flex-1 flex-col">
				{/* Persistent top bar: mobile carries the progress summary; every
				    breakpoint keeps sign-out reachable so a wrong-account sign-in
				    is always one click from recovery. */}
				<header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4 lg:px-12">
					<div className="min-w-0">
						<p className="text-xs font-semibold tracking-tight lg:hidden">Caracal</p>
						<p className="mt-0.5 text-[11px] text-muted-foreground lg:hidden">
							Step {current + 1} of {STEPS.length} · {STEPS[current].title}
						</p>
						<p className="hidden text-sm font-medium lg:block">{STEPS[current].title}</p>
					</div>
					<div className="flex items-center gap-3">
						<div className="flex items-center gap-1.5 lg:hidden" aria-hidden>
							{STEPS.map((step, i) => (
								<span
									key={step.id}
									className={cn(
										"h-1 w-6 rounded-full",
										i < current ? "bg-primary/50" : i === current ? "bg-primary" : "bg-border",
									)}
								/>
							))}
						</div>
						<SignOutButton />
					</div>
				</header>
				<main className="flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-8 lg:px-12 lg:py-16">{children}</div>
				</main>
			</div>
		</div>
	);
}

/** Shared stage header: kicker, heading, and supporting copy. */
export function StageHeader({
	kicker,
	title,
	description,
}: {
	kicker: string;
	title: string;
	description: string;
}) {
	return (
		<header>
			<p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">{kicker}</p>
			<h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
			<p className="mt-2 max-w-prose text-sm leading-6 text-muted-foreground">{description}</p>
		</header>
	);
}

/** Centered pending state while the authoritative snapshot resolves. */
export function StagePending() {
	return <div className="flex min-h-[40vh] items-center justify-center" aria-busy="true" />;
}
