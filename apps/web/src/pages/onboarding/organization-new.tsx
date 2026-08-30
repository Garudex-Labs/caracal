// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Onboarding: found a new organization. The creator becomes its owner and the
// server creates the protected default project alongside it, so a successful
// creation always yields a complete, enterable context. Retries are safe: the
// slug is unique server-side, so a duplicate submit conflicts instead of
// duplicating anything.

import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, FolderKanban, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { enterApp, useOnboardingStage } from "@/hooks/use-onboarding";
import { useCreateOrg } from "@/hooks/use-orgs-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StageHeader, StagePending } from "@/pages/onboarding/shell";

// Mirrors the server's organization id rule (3-32, lowercase, hyphens).
const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

function deriveSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 32)
		.replace(/^-|-$/g, "");
}

const FIELD_HINT = "mt-1.5 text-xs leading-5 text-muted-foreground";

export default function OnboardingOrganizationNewPage() {
	const { ready } = useOnboardingStage("organization");
	const search = useSearch({ strict: false }) as { next?: string };
	const navigate = useNavigate();
	const createOrg = useCreateOrg();

	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugTouched, setSlugTouched] = useState(false);
	const [description, setDescription] = useState("");

	if (!ready) return <StagePending />;

	const effectiveSlug = slugTouched ? slug : deriveSlug(name);
	const nameValid = name.trim().length > 0 && name.trim().length <= 255;
	const slugValid = ORG_SLUG_RE.test(effectiveSlug);
	const canSubmit = nameValid && slugValid && !createOrg.isPending;

	async function handleCreate() {
		if (!canSubmit) return;
		try {
			const org = await createOrg.mutateAsync({
				name: name.trim(),
				slug: effectiveSlug,
				...(description.trim() ? { description: description.trim() } : {}),
			});
			const project = org.default_project?.slug;
			if (project) {
				const destination = enterApp({ orgSlug: org.slug, projectSlug: project }, search.next);
				if (destination !== null) navigate({ to: destination });
				return;
			}
			// No default project in the response: let the resolver settle it.
			navigate({ to: "/onboarding", search: (prev) => prev });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create organization");
		}
	}

	return (
		<div className="space-y-10">
			<StageHeader
				kicker="Step 2 · Organization"
				title="Create your organization"
				description="The organization is your tenant: members, projects, and everything you publish live inside it. You become its owner."
			/>

			<section className="space-y-8">
				<div>
					<Label htmlFor="org-name" className="text-sm font-medium">
						Organization name
					</Label>
					<Input
						id="org-name"
						value={name}
						maxLength={255}
						placeholder="Acme Robotics"
						autoComplete="organization"
						onChange={(e) => setName(e.target.value)}
						className="mt-2 h-10"
					/>
					<p className={FIELD_HINT}>The display name shown across the workspace.</p>
				</div>

				<div>
					<Label htmlFor="org-slug" className="text-sm font-medium">
						Organization id
					</Label>
					<Input
						id="org-slug"
						value={effectiveSlug}
						placeholder="acme-robotics"
						autoComplete="off"
						spellCheck={false}
						onChange={(e) => {
							setSlugTouched(true);
							setSlug(e.target.value.toLowerCase());
						}}
						className="mt-2 h-10 font-mono"
						aria-invalid={effectiveSlug.length > 0 && !slugValid}
					/>
					<p className={FIELD_HINT}>
						Permanent address of your organization - used in URLs. 3–32 characters: lowercase letters, numbers, and
						hyphens.
					</p>
				</div>

				<div>
					<Label htmlFor="org-description" className="text-sm font-medium">
						Description <span className="font-normal text-muted-foreground">(optional)</span>
					</Label>
					<Textarea
						id="org-description"
						value={description}
						maxLength={2000}
						rows={3}
						placeholder="What this organization is for"
						onChange={(e) => setDescription(e.target.value)}
						className="mt-2"
					/>
				</div>

				<div className="flex items-start gap-3 rounded-md border border-border bg-card/40 px-4 py-3.5">
					<FolderKanban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<p className="text-xs leading-5 text-muted-foreground">
						A default project named{" "}
						<span className="font-mono text-foreground/80">{slugValid ? effectiveSlug : "your-org"}</span> is created
						with the organization. It always exists and cannot be deleted; teammates you invite later get access to
						projects through normal project membership.
					</p>
				</div>
			</section>

			<footer className="flex items-center justify-between border-t border-border pt-6">
				<Button
					variant="ghost"
					className="h-10 px-3 text-muted-foreground"
					onClick={() => navigate({ to: "/onboarding/organization", search: (prev) => prev })}
					disabled={createOrg.isPending}
				>
					<ArrowLeft className="mr-1.5 h-4 w-4" />
					Back
				</Button>
				<Button onClick={handleCreate} disabled={!canSubmit} className="h-10 px-5">
					{createOrg.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
					Create organization
					<ArrowRight className="ml-1.5 h-4 w-4" />
				</Button>
			</footer>
		</div>
	);
}
