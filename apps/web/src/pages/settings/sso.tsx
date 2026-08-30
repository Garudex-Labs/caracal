// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Enterprise SSO administration, backed entirely by the Better Auth SSO
// plugin: register OIDC or SAML 2.0 identity providers per email domain.
// Sign-in resolves the provider from the user's email domain.

import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { useRoleGuard } from "@/hooks/use-role-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
	SettingsCard,
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-shell";

type ProviderKind = "oidc" | "saml";

type SsoProvider = {
	id: string;
	providerId: string;
	issuer: string;
	domain: string;
	oidcConfig?: unknown;
	samlConfig?: unknown;
};

async function fetchProviders(): Promise<SsoProvider[]> {
	const res = await fetch("/api/auth/sso/providers", { credentials: "include" });
	if (!res.ok) throw new Error("Could not load SSO providers");
	const data = await res.json();
	return Array.isArray(data) ? data : (data?.providers ?? []);
}

export default function SsoSettingsPage() {
	const { ready } = useRoleGuard("operator");
	const qc = useQueryClient();
	const [kind, setKind] = useState<ProviderKind>("oidc");
	const [providerId, setProviderId] = useState("");
	const [domain, setDomain] = useState("");
	// OIDC fields
	const [issuer, setIssuer] = useState("");
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	// SAML fields
	const [entryPoint, setEntryPoint] = useState("");
	const [certificate, setCertificate] = useState("");
	const [idpMetadata, setIdpMetadata] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

	const providers = useQuery({
		queryKey: ["admin", "sso-providers"],
		queryFn: fetchProviders,
		enabled: ready,
	});

	const register = useMutation({
		mutationFn: async () => {
			const spBase = `${window.location.origin}/api/auth/sso/saml2/sp`;
			// Branch-typed calls so each payload is checked against the real signature.
			const { error } =
				kind === "oidc"
					? await authClient.sso.register({
							providerId,
							domain,
							issuer,
							oidcConfig: {
								clientId,
								clientSecret,
								issuer,
								discoveryEndpoint: `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
							},
						})
					: await authClient.sso.register({
							providerId,
							domain,
							issuer: entryPoint,
							samlConfig: {
								entryPoint,
								issuer: `${spBase}/metadata`,
								callbackUrl: `${spBase}/acs/${providerId}`,
								audience: `${spBase}/metadata`,
								cert: certificate,
								wantAssertionsSigned: true,
								...(idpMetadata.trim() ? { idpMetadata: { metadata: idpMetadata } } : {}),
								mapping: { id: "nameID", email: "email", name: "displayName" },
							},
						});
			if (error) throw new Error(error.message || "Failed to register provider");
		},
		onSuccess: () => {
			toast.success("SSO provider registered");
			setProviderId("");
			setDomain("");
			setIssuer("");
			setClientId("");
			setClientSecret("");
			setEntryPoint("");
			setCertificate("");
			setIdpMetadata("");
			qc.invalidateQueries({ queryKey: ["admin", "sso-providers"] });
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const remove = useMutation({
		mutationFn: async (id: string) => {
			const res = await fetch("/api/auth/sso/delete-provider", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providerId: id }),
			});
			if (!res.ok) throw new Error("Failed to delete provider");
		},
		onSuccess: () => {
			toast.success("Provider deleted");
			setDeleteTarget(null);
			qc.invalidateQueries({ queryKey: ["admin", "sso-providers"] });
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const submit = useCallback(() => {
		if (!providerId.trim() || !domain.trim()) {
			toast.error("Provider ID and email domain are required");
			return;
		}
		register.mutate();
	}, [providerId, domain, register]);

	if (!ready) return null;

	return (
		<SettingsPage
			title="Single Sign-On"
			description="Users whose email domain matches a provider sign in through it automatically. SCIM directory sync is managed by the identity service."
			scope="organization"
		>
			<SettingsSection
				id="providers"
				title="Registered providers"
				description="Domains are resolved at sign-in time."
			>
				<SettingsCard>
					{providers.isLoading ? (
						<div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" /> Loading…
						</div>
					) : providers.data?.length ? (
						providers.data.map((p) => (
							<div key={p.providerId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
								<div className="min-w-0">
									<span className="font-medium">{p.providerId}</span>
									<span className="ml-2 text-muted-foreground">{p.domain}</span>
									<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs uppercase">
										{p.samlConfig ? "saml" : "oidc"}
									</span>
								</div>
								{deleteTarget === p.providerId ? (
									<div className="flex shrink-0 items-center gap-1.5">
										<span className="text-xs text-muted-foreground">
											Users on {p.domain} lose SSO sign-in.
										</span>
										<Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDeleteTarget(null)}>
											Cancel
										</Button>
										<Button
											variant="destructive"
											size="sm"
											className="h-7 text-xs"
											onClick={() => remove.mutate(p.providerId)}
											disabled={remove.isPending}
										>
											{remove.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
											Delete
										</Button>
									</div>
								) : (
									<Button
										variant="ghost"
										size="sm"
										className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
										aria-label={`Delete provider ${p.providerId}`}
										onClick={() => setDeleteTarget(p.providerId)}
									>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								)}
							</div>
						))
					) : (
						<p className="px-4 py-3 text-sm text-muted-foreground">No providers registered yet.</p>
					)}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				id="register"
				title="Register a provider"
				description="OIDC needs the issuer plus client credentials; SAML needs the IdP SSO URL and signing certificate (or metadata XML)."
			>
				<SettingsCard>
					<div className="space-y-4 px-4 py-4">
						<div className="flex gap-2">
							<Button
								type="button"
								variant={kind === "oidc" ? "default" : "outline"}
								size="sm"
								onClick={() => setKind("oidc")}
							>
								OIDC
							</Button>
							<Button
								type="button"
								variant={kind === "saml" ? "default" : "outline"}
								size="sm"
								onClick={() => setKind("saml")}
							>
								SAML 2.0
							</Button>
						</div>

						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="sso-provider-id">Provider ID</Label>
								<Input
									id="sso-provider-id"
									placeholder="acme-okta"
									value={providerId}
									onChange={(e) => setProviderId(e.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="sso-domain">Email domain</Label>
								<Input
									id="sso-domain"
									placeholder="acme.com"
									value={domain}
									onChange={(e) => setDomain(e.target.value)}
								/>
							</div>
						</div>

						{kind === "oidc" ? (
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-1.5 sm:col-span-2">
									<Label htmlFor="sso-issuer">Issuer URL</Label>
									<Input
										id="sso-issuer"
										placeholder="https://idp.acme.com"
										value={issuer}
										onChange={(e) => setIssuer(e.target.value)}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="sso-client-id">Client ID</Label>
									<Input id="sso-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} />
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="sso-client-secret">Client secret</Label>
									<Input
										id="sso-client-secret"
										type="password"
										value={clientSecret}
										onChange={(e) => setClientSecret(e.target.value)}
									/>
								</div>
							</div>
						) : (
							<div className="grid gap-4">
								<div className="space-y-1.5">
									<Label htmlFor="saml-entry">IdP single sign-on URL</Label>
									<Input
										id="saml-entry"
										placeholder="https://idp.acme.com/sso/saml"
										value={entryPoint}
										onChange={(e) => setEntryPoint(e.target.value)}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="saml-cert">IdP X.509 certificate (PEM)</Label>
									<Textarea
										id="saml-cert"
										rows={4}
										placeholder="-----BEGIN CERTIFICATE-----"
										value={certificate}
										onChange={(e) => setCertificate(e.target.value)}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="saml-metadata">IdP metadata XML (optional)</Label>
									<Textarea
										id="saml-metadata"
										rows={4}
										value={idpMetadata}
										onChange={(e) => setIdpMetadata(e.target.value)}
									/>
								</div>
							</div>
						)}

						<Button onClick={submit} disabled={register.isPending}>
							{register.isPending ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Plus className="mr-2 h-4 w-4" />
							)}
							Register provider
						</Button>
					</div>
				</SettingsCard>
			</SettingsSection>
		</SettingsPage>
	);
}
