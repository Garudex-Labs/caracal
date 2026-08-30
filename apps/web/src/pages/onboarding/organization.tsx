// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Onboarding stage 2: establish a real organization relationship. The two
// paths mirror the domain - found a new organization (you become its owner),
// or join an existing one through an invitation addressed to your account.
// Membership is never implicit; there is nothing to "skip" into.

import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, Building2, Loader2, MailOpen, RefreshCw, Ticket } from "lucide-react";
import { toast } from "sonner";
import { setCurrentOrgSlug } from "@/hooks/use-current-org";
import { useInvalidateOnboarding, useOnboardingStage } from "@/hooks/use-onboarding";
import { useAcceptInvitation, useInvitationPreview } from "@/hooks/use-orgs-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StageHeader, StagePending } from "@/pages/onboarding/shell";
import type { OnboardingInvitation, OrgInvitation } from "@/lib/types";

const PANEL = "rounded-md border border-border";

function roleBadge(role: string) {
	return (
		<Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-medium capitalize">
			{role}
		</Badge>
	);
}

/** Accept an invitation, remember the org, and let the resolver re-route. */
function useAccept() {
	const accept = useAcceptInvitation();
	const navigate = useNavigate();
	const run = async (args: { id: string } | { token: string }) => {
		const org = await accept.mutateAsync(args);
		if (org?.slug) setCurrentOrgSlug(org.slug);
		// Drop the consumed invite token so the resolver settles on live state.
		navigate({ to: "/onboarding", search: (prev) => ({ ...prev, invite: undefined }) });
	};
	return { run, pending: accept.isPending };
}

/** The invitation behind a followed link (?invite=<token>). */
function InviteTokenCard({ token }: { token: string }) {
	const preview = useInvitationPreview(token);
	const { run, pending } = useAccept();

	if (preview.isLoading) {
		return (
			<div className={`${PANEL} flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground`}>
				<Loader2 className="h-4 w-4 animate-spin" />
				Checking your invitation…
			</div>
		);
	}
	if (preview.isError) {
		return (
			<div className={`${PANEL} px-4 py-4`}>
				<p className="text-sm font-medium">This invitation link isn't valid</p>
				<p className="mt-1 text-xs leading-5 text-muted-foreground">
					The link may have been revoked or replaced. Ask an organization admin to send a new one -
					invitations addressed to your account also appear below automatically.
				</p>
			</div>
		);
	}
	const inv = preview.data as OrgInvitation;
	if (inv.state !== "pending") {
		const explanation: Record<string, string> = {
			expired: "This invitation has expired. Ask an organization admin to send a new one.",
			revoked: "This invitation was revoked by an organization admin.",
			accepted: "This invitation was already used. If that was you, your membership is already in place.",
		};
		return (
			<div className={`${PANEL} px-4 py-4`}>
				<p className="text-sm font-medium">
					Invitation to {inv.org_name} · <span className="capitalize text-muted-foreground">{inv.state}</span>
				</p>
				<p className="mt-1 text-xs leading-5 text-muted-foreground">{explanation[inv.state]}</p>
			</div>
		);
	}
	return (
		<div className={`${PANEL} border-primary/40 bg-primary/5 px-4 py-4`}>
			<div className="flex items-center gap-3">
				<Ticket className="h-4 w-4 shrink-0 text-primary" />
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">You're invited to {inv.org_name}</p>
					<p className="truncate text-xs text-muted-foreground">
						as {inv.role} · sent to {inv.email}
					</p>
				</div>
				<Button
					size="sm"
					className="h-8 shrink-0"
					disabled={pending}
					onClick={() => run({ token }).catch((e) => toast.error(e instanceof Error ? e.message : "Failed to join"))}
				>
					{pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
					Accept & join
				</Button>
			</div>
		</div>
	);
}

function PendingInvitationRow({ inv }: { inv: OnboardingInvitation }) {
	const { run, pending } = useAccept();
	return (
		<li className="flex items-center gap-3 px-4 py-3">
			<Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{inv.org_name}</p>
				<p className="truncate font-mono text-[11px] text-muted-foreground">{inv.org_slug}</p>
			</div>
			{roleBadge(inv.role)}
			<Button
				size="sm"
				variant="outline"
				className="h-8 shrink-0"
				disabled={pending}
				onClick={() => run({ id: inv.id }).catch((e) => toast.error(e instanceof Error ? e.message : "Failed to join"))}
			>
				{pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
				Accept
			</Button>
		</li>
	);
}

export default function OnboardingOrganizationPage() {
	const search = useSearch({ strict: false }) as { invite?: string; next?: string };
	// An explicit invitation link keeps this stage open for already-onboarded
	// users joining an additional organization.
	const { snapshot, ready, query } = useOnboardingStage(
		"organization",
		search.invite ? ["project", "done"] : [],
	);
	const invalidate = useInvalidateOnboarding();
	const navigate = useNavigate();
	const [refreshing, setRefreshing] = useState(false);

	if (!ready || !snapshot) return <StagePending />;

	const invitations = snapshot.invitations;

	async function refresh() {
		setRefreshing(true);
		invalidate();
		await query.refetch();
		setRefreshing(false);
	}

	return (
		<div className="space-y-10">
			<StageHeader
				kicker="Step 2 · Organization"
				title="Join your team or start fresh"
				description="Your work lives inside an organization. Accept an invitation to join an existing one, or create your own - it comes with a default project ready to use."
			/>

			{search.invite && <InviteTokenCard token={search.invite} />}

			<section aria-labelledby="onboarding-invitations">
				<div className="flex items-center justify-between">
					<h2 id="onboarding-invitations" className="text-[13px] font-semibold uppercase tracking-wider text-foreground/80">
						Invitations for {snapshot.profile.email}
					</h2>
					<Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" onClick={refresh} disabled={refreshing}>
						<RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
						Refresh
					</Button>
				</div>
				{invitations.length === 0 ? (
					<div className={`${PANEL} mt-3 flex items-start gap-3 px-4 py-4`}>
						<MailOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
						<p className="text-xs leading-5 text-muted-foreground">
							No pending invitations. If your team already uses Caracal, ask an organization admin to invite{" "}
							<span className="font-mono text-foreground/80">{snapshot.profile.email}</span> - it appears here the
							moment it's sent.
						</p>
					</div>
				) : (
					<ul className={`${PANEL} mt-3 divide-y divide-border`}>
						{invitations.map((inv) => (
							<PendingInvitationRow key={inv.id} inv={inv} />
						))}
					</ul>
				)}
			</section>

			<section aria-labelledby="onboarding-create-org">
				<h2 id="onboarding-create-org" className="text-[13px] font-semibold uppercase tracking-wider text-foreground/80">
					Start your own
				</h2>
				<div className={`${PANEL} mt-3 flex items-center gap-4 px-4 py-4`}>
					<Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<p className="text-sm font-medium">Create an organization</p>
						<p className="mt-0.5 text-xs leading-5 text-muted-foreground">
							You become its owner, and a default project named after it is created for you.
						</p>
					</div>
					<Button
						className="h-9 shrink-0"
						onClick={() => navigate({ to: "/onboarding/organization/new", search: (prev) => prev })}
					>
						Create
						<ArrowRight className="ml-1.5 h-4 w-4" />
					</Button>
				</div>
			</section>

			<p className="text-xs leading-5 text-muted-foreground">
				Signed in with the wrong account?{" "}
				<Link to="/login" className="font-medium text-foreground underline underline-offset-4">
					Switch accounts
				</Link>
				.
			</p>
		</div>
	);
}
