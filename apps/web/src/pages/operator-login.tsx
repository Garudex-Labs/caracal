// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Dedicated sign-in for the deployment control plane. Unlike the tenant
// login (/login), the operator console admits only federated identity:
// Google in every environment, plus the development login on a local
// stack. Credentials, magic links, passkeys, and self-registration are
// deliberately absent; operator accounts are provisioned, never enrolled.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, ShieldCheck, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import {
	auth,
	activateAuthContext,
	clearSession,
	ensureAccessToken,
	setUserRole,
	setUserName,
	setUserEmail,
	setUserUsername,
	setUserAvatar,
} from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useDeploymentConfig } from "@/hooks/use-deployment-config";
import { Button } from "@/components/ui/button";
import { GoogleGIcon } from "@/components/ui/google-g-icon";

const OPERATOR_HOME = "/operator";

/** Prime the registry JWT and profile caches, then land on the console. */
async function completeOperatorSignIn(): Promise<void> {
	clearSession("tenant");
	const token = await ensureAccessToken("operator", true);
	if (!token) throw new Error("Signed in, but no session was found. Please try again.");
	const user = await auth.whoami("operator");
	if (user.role !== "operator") {
		await authClient.signOut().catch(() => undefined);
		clearSession();
		window.dispatchEvent(new Event("storage"));
		throw new Error("This account is not authorized for the operator console.");
	}
	setUserRole(user.role, "operator");
	setUserName(user.name, "operator");
	setUserEmail(user.email, "operator");
	if (user.username) setUserUsername(user.username, "operator");
	if (user.avatar_url) setUserAvatar(user.avatar_url, "operator");
	window.dispatchEvent(new Event("storage"));
	window.location.replace(OPERATOR_HOME);
}

export default function OperatorLoginPage() {
	const { googleSsoEnabled, devLoginEnabled, brandingAppName, loading } = useDeploymentConfig();
	const appName = brandingAppName || "Caracal";
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function handleGoogle() {
		setBusy(true);
		setError("");
		clearSession("tenant");
		activateAuthContext("operator");
		const { error: socialError } = await authClient.signIn.social({
			provider: "google",
			callbackURL: OPERATOR_HOME,
			errorCallbackURL: "/operator-login",
		});
		if (socialError) {
			clearSession("operator");
			setError(socialError.message || "Could not start Google sign-in");
			setBusy(false);
		}
	}

	async function handleDevLogin() {
		setBusy(true);
		setError("");
		try {
			clearSession("tenant");
			const res = await fetch("/api/auth/dev/login", { method: "POST", credentials: "include" });
			if (!res.ok) throw new Error("Development login is not available");
			await completeOperatorSignIn();
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Development login failed";
			setError(msg);
			toast.error(msg);
			setBusy(false);
		}
	}

	const noMethods = !loading && !googleSsoEnabled && !devLoginEnabled;

	return (
		<div className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-card p-8 shadow-sm">
				<div className="space-y-2 text-center">
					<div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg border border-warning/40 bg-warning/5 text-warning">
						<ShieldCheck className="h-5 w-5" />
					</div>
					<h1 className="text-lg font-semibold tracking-tight">Operator Console</h1>
					<p className="text-[13px] text-muted-foreground">
						Sign in to operate the {appName} deployment. This area is for the team hosting the
						installation, not for organization administration.
					</p>
				</div>

				{loading ? (
					<div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Checking sign-in options
					</div>
				) : (
					<div className="space-y-3">
						{googleSsoEnabled && (
							<Button
								type="button"
								variant="outline"
								className="h-12 w-full gap-2"
								disabled={busy}
								onClick={handleGoogle}
							>
								<GoogleGIcon className="h-4 w-4" />
								Continue with Google
							</Button>
						)}
						{devLoginEnabled && (
							<Button
								type="button"
								variant="outline"
								className="h-12 w-full gap-2 border-dashed"
								disabled={busy}
								onClick={handleDevLogin}
							>
								{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
								Development login
							</Button>
						)}
						{noMethods && (
							<p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
								No operator sign-in method is configured. Set a Google provider (or enable the
								development login on a local stack).
							</p>
						)}
					</div>
				)}

				{error && (
					<p className="text-center text-xs text-destructive" role="alert">
						{error}
					</p>
				)}

				<Link
					to="/login"
					className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					<ArrowLeft className="h-3 w-3" />
					Organization sign-in
				</Link>
			</div>
		</div>
	);
}
