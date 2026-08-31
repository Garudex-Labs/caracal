// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Split-screen auth page shared by /login and /register. All credential
// handling goes through Better Auth (lib/auth-client.ts): email/password,
// Google, GitHub, enterprise SSO, passkeys, magic links, and the
// development-only dummy login. After a session exists, a registry JWT is
// minted and profile caches are primed before redirecting.

import { useState, useEffect } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { Eye, EyeOff, ArrowRight, Loader2, AlertCircle, Building2, KeyRound, MailCheck, ShieldCheck, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { activateAuthContext, auth, clearSession, ensureAccessToken, setUserRole, setUserName, setUserEmail, setUserUsername, setUserAvatar } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { authPageState, type AuthCapabilitySnapshot } from "@/lib/auth-methods";
import { isTenantNext, tenantNext } from "@/lib/safe-next";
import { useDeploymentConfig } from "@/hooks/use-deployment-config";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { GoogleGIcon } from "@/components/ui/google-g-icon";
import { GithubMarkIcon } from "@/components/ui/github-mark-icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AuthMode = "login" | "register";

type AuthSearch = {
	next?: string;
	error?: string;
	reason?: string;
	sso?: string;
};

const PASSWORD_RULES = [
	{ id: "len", label: "At least 12 characters", test: (p: string) => p.length >= 12 },
	{ id: "upper", label: "One uppercase letter", test: (p: string) => /[A-Z]/.test(p) },
	{ id: "digit", label: "One number", test: (p: string) => /[0-9]/.test(p) },
	{ id: "special", label: "One special character", test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

function passwordIsStrong(password: string) {
	return PASSWORD_RULES.every((rule) => rule.test(password));
}

const FIELD_LABEL = "text-xs font-medium uppercase tracking-wider text-muted-foreground";
const TALL_INPUT = "h-12 border-border/70 bg-card/60 focus-visible:border-primary focus-visible:ring-primary/25";
const TALL_BUTTON = "h-12 w-full text-sm uppercase tracking-wider";
const CTA_BUTTON = `${TALL_BUTTON} bg-primary font-semibold text-primary-foreground hover:bg-primary/90`;
const SSO_BUTTON = `${TALL_BUTTON} border-border/70 bg-card/60 font-medium hover:bg-accent hover:text-foreground`;
const ACCENT_LINK = "font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary/80";

/** The post-auth onboarding resolver, preserving the destination. */
function onboardingUrl(next?: string): string {
	const destination = tenantNext(next);
	return destination === "/" ? "/onboarding" : `/onboarding?next=${encodeURIComponent(destination)}`;
}

const LOGIN_BOUNCE_KEY = "caracal_login_bounce";

/**
 * Bounded guard for the authenticated auto-redirect: if login keeps sending an
 * already-signed-in visitor to a destination that bounces straight back (a
 * session that will not span to the target origin), stop after a few rapid
 * hops so the user gets a fresh sign-in instead of an infinite apex<->subdomain
 * loop. The window resets stale counters so a normal later sign-in is unaffected.
 */
function loginRedirectLoopTripped(): boolean {
	if (typeof sessionStorage === "undefined") return false;
	const now = Date.now();
	const [countRaw, tsRaw] = (sessionStorage.getItem(LOGIN_BOUNCE_KEY) ?? "0:0").split(":");
	const count = now - Number(tsRaw) > 5000 ? 0 : Number(countRaw) || 0;
	if (count >= 3) {
		sessionStorage.removeItem(LOGIN_BOUNCE_KEY);
		return true;
	}
	sessionStorage.setItem(LOGIN_BOUNCE_KEY, `${count + 1}:${now}`);
	return false;
}

/** Prime the registry JWT and profile caches after Better Auth establishes a session. */
async function completeSignIn(next?: string): Promise<void> {
	clearSession("operator");
	const token = await ensureAccessToken("tenant", true);
	if (!token) throw new Error("Signed in, but no session was found. Please try again.");
	const user = await auth.whoami("tenant");
	setUserRole(user.role, "tenant");
	setUserName(user.name, "tenant");
	setUserEmail(user.email, "tenant");
	if (user.username) setUserUsername(user.username, "tenant");
	if (user.avatar_url) setUserAvatar(user.avatar_url, "tenant");
	window.dispatchEvent(new Event("storage"));
	window.location.replace(onboardingUrl(next));
}

function errorMessage(e: unknown, fallback: string): string {
	if (e && typeof e === "object" && "message" in e && typeof (e as Error).message === "string") {
		return (e as Error).message || fallback;
	}
	return fallback;
}

export function AuthPage({ initialMode }: { initialMode: AuthMode }) {
	const searchParams = useSearch({ strict: false }) as AuthSearch;
	const {
		ssoEnabled,
		googleSsoEnabled,
		githubSsoEnabled,
		ssoOnly,
		selfRegistrationEnabled,
		devLoginEnabled,
		magicLinksEnabled,
		passkeysEnabled,
		emailPasswordEnabled,
		authAvailable,
		brandingAppName,
		brandingLogo,
		brandingWordmark,
		loading: configLoading,
		configError,
		refetchConfig,
	} = useDeploymentConfig();
	const appName = brandingAppName || "Caracal";

	const capabilities: AuthCapabilitySnapshot = {
		loading: configLoading,
		fetchFailed: configError,
		authAvailable,
		emailPassword: emailPasswordEnabled,
		magicLinks: magicLinksEnabled,
		google: googleSsoEnabled,
		github: githubSsoEnabled,
		sso: ssoEnabled,
		passkeys: passkeysEnabled,
		devLogin: devLoginEnabled,
	};
	const pageState = authPageState(capabilities);

	const [mode, setMode] = useState<AuthMode>(initialMode);
	const isLogin = mode === "login";

	// ── Login state ─────────────────────────────────────────────────
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [ssoLoading, setSsoLoading] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [showEnterpriseSso, setShowEnterpriseSso] = useState(false);
	const [ssoEmail, setSsoEmail] = useState("");
	const [magicLinkSent, setMagicLinkSent] = useState(false);

	// ── Register state ──────────────────────────────────────────────
	const [regName, setRegName] = useState("");
	const [regEmail, setRegEmail] = useState("");
	const [regUsername, setRegUsername] = useState("");
	const [regPassword, setRegPassword] = useState("");
	const [regConfirmPassword, setRegConfirmPassword] = useState("");
	const [regPasswordTouched, setRegPasswordTouched] = useState(false);
	const regPasswordStrong = passwordIsStrong(regPassword);
	const regPasswordsMatch = regPassword === regConfirmPassword;

	const nextTarget = isTenantNext(searchParams.next) ? searchParams.next : undefined;
	// SSO and magic-link providers return the browser here after auth, so the
	// callback runs through the same onboarding resolver as password sign-in.
	const callbackURL = onboardingUrl(nextTarget);

	function toggleMode() {
		setError("");
		setMode((m) => (m === "login" ? "register" : "login"));
	}

	// Signed-in visitors go straight through; a live identity-service
	// session mints a token silently, otherwise the form renders.
	useEffect(() => {
		if (typeof window === "undefined") return;
		let cancelled = false;
		ensureAccessToken("tenant").then((token) => {
			if (cancelled || !token) return;
			if (loginRedirectLoopTripped()) {
				clearSession("tenant");
				window.dispatchEvent(new Event("storage"));
				setError("Your session could not be established for that workspace. Please sign in again.");
				return;
			}
			window.location.replace(onboardingUrl(searchParams.next));
		});
		return () => {
			cancelled = true;
		};
	}, [searchParams.next]);

	useEffect(() => {
		if (searchParams.error) setError(searchParams.error || "Authentication failed");
	}, [searchParams.error]);

	useEffect(() => {
		const reason = searchParams.reason;
		if (reason === "session_expired") {
			toast.info("Your session has expired. Please sign in again.");
			const preserved = nextTarget ? `/login?next=${encodeURIComponent(nextTarget)}` : "/login";
			window.history.replaceState({}, "", preserved);
		}
	}, [searchParams.reason, nextTarget]);

	async function handlePasswordLogin() {
		setError("");
		setLoading(true);
		try {
			const { error: signInError } = await authClient.signIn.email({ email, password });
			if (signInError) {
				throw new Error(signInError.message || "Invalid email or password");
			}
			toast.success("Signed in successfully");
			await completeSignIn(nextTarget);
		} catch (e) {
			const raw = errorMessage(e, "Login failed");
			const msg = raw.toLowerCase().includes("rate limit")
				? "Too many login attempts. Please wait a minute before trying again."
				: raw;
			setError(msg);
			toast.error(msg);
			setLoading(false);
		}
	}

	async function handleRegister() {
		setError("");
		if (regPassword !== regConfirmPassword) {
			setError("Passwords do not match");
			return;
		}
		if (!regPasswordStrong) {
			setError("Password does not meet the requirements");
			return;
		}

		setLoading(true);
		try {
			const { error: signUpError } = await authClient.signUp.email({
				email: regEmail,
				password: regPassword,
				name: regName,
			});
			if (signUpError) {
				throw new Error(signUpError.message || "Registration failed");
			}
			// Verification-required deployments have no session yet.
			const token = await ensureAccessToken("tenant", true);
			if (!token) {
				toast.success("Account created. Check your email to verify your address, then sign in.");
				setMode("login");
				setLoading(false);
				return;
			}
			if (regUsername.trim()) {
				await auth.updateUsername({ username: regUsername.trim() }).catch(() => {
					toast.warning("Account created, but the username was not available. Set it later in account settings.");
				});
			}
			toast.success("Account created");
			await completeSignIn(nextTarget);
		} catch (e) {
			const msg = errorMessage(e, "Registration failed");
			setError(msg);
			toast.error(msg);
			setLoading(false);
		}
	}

	async function handleSocialLogin(provider: "google" | "github") {
		setSsoLoading(true);
		setError("");
		clearSession("operator");
		activateAuthContext("tenant");
		const { error: socialError } = await authClient.signIn.social({
			provider,
			callbackURL,
			errorCallbackURL: "/login",
		});
		if (socialError) {
			clearSession("tenant");
			setError(socialError.message || `Could not start ${provider} sign-in`);
			setSsoLoading(false);
		}
	}

	async function handleEnterpriseSso() {
		const identifier = (ssoEmail || email).trim();
		if (!identifier.includes("@")) {
			setError("Enter your work email so we can find your identity provider.");
			setShowEnterpriseSso(true);
			return;
		}
		setSsoLoading(true);
		setError("");
		clearSession("operator");
		activateAuthContext("tenant");
		const { error: ssoError } = await authClient.signIn.sso({
			email: identifier,
			callbackURL,
			errorCallbackURL: "/login",
		});
		if (ssoError) {
			clearSession("tenant");
			setError(ssoError.message || "No identity provider is configured for this email domain.");
			setSsoLoading(false);
		}
	}

	async function handleMagicLink() {
		const identifier = email.trim();
		if (!identifier.includes("@")) {
			setError("Enter your email above, then request a sign-in link.");
			return;
		}
		setError("");
		clearSession("operator");
		activateAuthContext("tenant");
		const { error: magicError } = await authClient.signIn.magicLink({
			email: identifier,
			callbackURL,
		});
		if (magicError) {
			clearSession("tenant");
			setError(magicError.message || "Could not send the sign-in link.");
			return;
		}
		setMagicLinkSent(true);
		toast.success("Sign-in link sent. Check your email.");
	}

	async function handlePasskeyLogin() {
		setError("");
		setLoading(true);
		try {
			const result = await authClient.signIn.passkey();
			if (result?.error) {
				throw new Error(result.error.message || "Passkey sign-in failed");
			}
			await completeSignIn(nextTarget);
		} catch (e) {
			setError(errorMessage(e, "Passkey sign-in failed"));
			setLoading(false);
		}
	}

	async function handleDevLogin() {
		setError("");
		setLoading(true);
		try {
			const res = await fetch("/api/auth/dev/login", {
				method: "POST",
				credentials: "include",
			});
			if (!res.ok) throw new Error("Development login is not available");
			await completeSignIn(nextTarget);
		} catch (e) {
			const msg = errorMessage(e, "Development login failed");
			setError(msg);
			toast.error(msg);
			setLoading(false);
		}
	}

	const brandMark = brandingLogo ? (
		<img loading="lazy" src={brandingLogo} alt="" width={28} height={28} className="object-contain" />
	) : (
		<img loading="lazy" src="/caracal_horizontal.png" alt="" width={28} height={28} className="object-contain" />
	);

	// ── Capability-derived page states ────────────────────────────────
	if (pageState === "loading") {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-6">
				<div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
					<Loader2 className="h-4 w-4 animate-spin" />
					Checking sign-in options
				</div>
			</div>
		);
	}
	if (pageState === "unavailable") {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-6">
				<div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
					<AlertCircle className="mx-auto h-10 w-10 text-muted-foreground" />
					<h1 className="mt-4 text-2xl font-semibold tracking-tight">Sign-in is temporarily unavailable</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						The sign-in service did not respond. This is usually brief; try again in a moment.
					</p>
					<Button className="mt-6 w-full" onClick={() => refetchConfig()}>
						Try again
					</Button>
				</div>
			</div>
		);
	}
	if (pageState === "unconfigured") {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-6">
				<div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
					<ShieldCheck className="mx-auto h-10 w-10 text-muted-foreground" />
					<h1 className="mt-4 text-2xl font-semibold tracking-tight">Sign-in is not set up</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						No sign-in method is configured for this deployment. An administrator needs to enable at
						least one authentication method on the identity service.
					</p>
				</div>
			</div>
		);
	}

	// ── Direct /register visit while registration is closed ──────────
	if (initialMode === "register" && (ssoOnly || !selfRegistrationEnabled)) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-6">
				<div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
					<ShieldCheck className="mx-auto h-10 w-10 text-muted-foreground" />
					<h1 className="mt-4 text-2xl font-semibold tracking-tight">Registration is closed</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						{ssoOnly
							? "This server uses SSO sign-in. Your account is created automatically the first time you sign in with your identity provider."
							: "Ask your admin for access, or sign in if you already have an account."}
					</p>
					<Button asChild className="mt-6 w-full">
						<Link to="/login">Back to sign in</Link>
					</Button>
				</div>
			</div>
		);
	}

	const canRegister = selfRegistrationEnabled && !ssoOnly;
	const showPasswordForm = emailPasswordEnabled && !ssoOnly;

	return (
		<div className="flex min-h-dvh overflow-hidden bg-surface-sunken text-foreground">
			{/* ── Form panel: slides right in login mode ─────────────────── */}
			<div
				className={cn(
					"relative z-10 flex w-full flex-col items-center justify-center px-6 py-16 transition-transform duration-700 ease-in-out sm:px-8 lg:w-1/2",
					isLogin ? "lg:translate-x-full" : "lg:translate-x-0",
				)}
			>
				<div className="absolute left-6 top-6 flex items-center gap-2.5 sm:left-8 sm:top-8">
					{brandMark}
					{brandingWordmark ? (
						<img loading="lazy" src={brandingWordmark} alt={appName} width={160} height={20} className="h-5 max-w-40 object-contain" />
					) : null}
				</div>
				<div className="w-full max-w-md space-y-8">
					<div className="space-y-2 text-center">
						<h1 className="text-3xl font-semibold tracking-tight font-[family-name:var(--font-display)]">
							{isLogin ? "Welcome back" : "Create an account"}
						</h1>
						{canRegister ? (
							<p className="text-sm text-muted-foreground">
								{isLogin ? "Don't have an account? " : "Already have an account? "}
								<button type="button" onClick={toggleMode} className={ACCENT_LINK}>
									{isLogin ? "Sign up" : "Sign in"}
								</button>
							</p>
						) : (
							<p className="text-sm text-muted-foreground">
								{ssoOnly ? "Continue with your identity provider" : "Sign in to your account"}
							</p>
						)}
					</div>

					{isLogin ? (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								if (showPasswordForm) handlePasswordLogin();
								else if (magicLinksEnabled) handleMagicLink();
							}}
							className="space-y-6"
						>
							{showPasswordForm && (
								<>
									<div className="space-y-2">
										<Label htmlFor="email" className={FIELD_LABEL}>Email</Label>
										<Input
											id="email"
											type="email"
											placeholder="you@company.com"
											value={email}
											onChange={(e) => setEmail(e.target.value)}
											required
											autoFocus
											className={TALL_INPUT}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="password" className={FIELD_LABEL}>Password</Label>
										<div className="relative">
											<Input
												id="password"
												type={showPassword ? "text" : "password"}
												placeholder="Enter password"
												value={password}
												onChange={(e) => setPassword(e.target.value)}
												required
												className={cn(TALL_INPUT, "pr-10")}
											/>
											<button
												type="button"
												tabIndex={-1}
												className="absolute right-0 top-0 flex h-full w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
												onClick={() => setShowPassword(!showPassword)}
											>
												{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
											</button>
										</div>
									</div>
									<div className="flex items-center justify-between text-xs">
										<button
											type="button"
											className={ACCENT_LINK}
											onClick={async () => {
												if (!email.includes("@")) {
													setError("Enter your email above, then use 'Forgot password'.");
													return;
												}
												const { error: resetError } = await authClient.requestPasswordReset({
													email,
													redirectTo: "/reset-password",
												});
												if (resetError) {
													setError(resetError.message || "Could not send the reset email.");
												} else {
													toast.success("If that account exists, a reset link is on its way.");
												}
											}}
										>
											Forgot password?
										</button>
										{magicLinksEnabled && (
											<button type="button" className={ACCENT_LINK} onClick={handleMagicLink}>
												{magicLinkSent ? "Resend sign-in link" : "Email me a sign-in link"}
											</button>
										)}
									</div>
								</>
							)}

							{/* Passwordless-primary: the sign-in link is the main path. */}
							{!showPasswordForm && magicLinksEnabled && !magicLinkSent && (
								<div className="space-y-2">
									<Label htmlFor="email" className={FIELD_LABEL}>Email</Label>
									<Input
										id="email"
										type="email"
										placeholder="you@company.com"
										value={email}
										onChange={(e) => setEmail(e.target.value)}
										required
										autoFocus
										className={TALL_INPUT}
									/>
								</div>
							)}

							{magicLinkSent && (
								<div className="flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2.5 text-sm">
									<MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
									<span>Check your inbox for a one-time sign-in link.</span>
								</div>
							)}

							{error && (
								<div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
									<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
									<span>{error}</span>
								</div>
							)}

							<div className="space-y-4">
								{showPasswordForm && (
									<Button type="submit" disabled={loading || ssoLoading} className={CTA_BUTTON}>
										{loading && !ssoLoading ? (
											<Loader2 className="h-4 w-4 animate-spin" />
										) : (
											<>
												Sign in
												<ArrowRight className="ml-2 h-4 w-4" />
											</>
										)}
									</Button>
								)}

								{!showPasswordForm && magicLinksEnabled && (
									<Button type="submit" disabled={loading || ssoLoading} className={CTA_BUTTON}>
										{magicLinkSent ? "Resend sign-in link" : "Email me a sign-in link"}
										<ArrowRight className="ml-2 h-4 w-4" />
									</Button>
								)}

								{/* Alternatives sit under one divider so the primary path stays unambiguous. */}
								{(showPasswordForm || (!showPasswordForm && magicLinksEnabled)) &&
									(googleSsoEnabled || githubSsoEnabled || ssoEnabled || (passkeysEnabled && !ssoOnly) || devLoginEnabled) && (
										<div className="flex items-center gap-3 text-xs uppercase tracking-wider text-muted-foreground/60">
											<span className="h-px flex-1 bg-border/70" />
											or
											<span className="h-px flex-1 bg-border/70" />
										</div>
									)}

								{googleSsoEnabled && (
									<Button
										type="button"
										variant={ssoOnly ? "default" : "outline"}
										className={ssoOnly ? CTA_BUTTON : SSO_BUTTON}
										onClick={() => handleSocialLogin("google")}
										disabled={loading || ssoLoading}
									>
										{ssoLoading ? (
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										) : (
											<GoogleGIcon className="mr-2 h-4 w-4" />
										)}
										Continue with Google
									</Button>
								)}

								{githubSsoEnabled && (
									<Button
										type="button"
										variant={ssoOnly ? "default" : "outline"}
										className={ssoOnly ? CTA_BUTTON : SSO_BUTTON}
										onClick={() => handleSocialLogin("github")}
										disabled={loading || ssoLoading}
									>
										{ssoLoading ? (
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										) : (
											<GithubMarkIcon className="mr-2 h-4 w-4" />
										)}
										Continue with GitHub
									</Button>
								)}

								{ssoEnabled && (
									<div className="space-y-2">
										<Button
											type="button"
											variant={ssoOnly ? "default" : "outline"}
											className={ssoOnly ? CTA_BUTTON : SSO_BUTTON}
											onClick={() => (showEnterpriseSso ? handleEnterpriseSso() : setShowEnterpriseSso(true))}
											disabled={loading || ssoLoading}
										>
											{ssoLoading ? (
												<Loader2 className="mr-2 h-4 w-4 animate-spin" />
											) : (
												<Building2 className="mr-2 h-4 w-4" />
											)}
											Enterprise SSO
										</Button>
										{showEnterpriseSso && (
											<div className="flex gap-2">
												<Input
													type="email"
													placeholder="you@company.com"
													value={ssoEmail}
													onChange={(e) => setSsoEmail(e.target.value)}
													className={TALL_INPUT}
													autoFocus
												/>
												<Button
													type="button"
													className="h-12 shrink-0"
													onClick={handleEnterpriseSso}
													disabled={ssoLoading}
												>
													<ArrowRight className="h-4 w-4" />
												</Button>
											</div>
										)}
									</div>
								)}

								{passkeysEnabled && !ssoOnly && (
									<Button
										type="button"
										variant="outline"
										className={SSO_BUTTON}
										onClick={handlePasskeyLogin}
										disabled={loading || ssoLoading}
									>
										<KeyRound className="mr-2 h-4 w-4" />
										Sign in with a passkey
									</Button>
								)}

								{devLoginEnabled && (
									<Button
										type="button"
										variant="outline"
										className={cn(SSO_BUTTON, "border-dashed border-amber-500/60 text-amber-600 hover:text-amber-600")}
										onClick={handleDevLogin}
										disabled={loading || ssoLoading}
									>
										<Wand2 className="mr-2 h-4 w-4" />
										Development login
									</Button>
								)}
							</div>
						</form>
					) : (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								handleRegister();
							}}
							className="space-y-5"
						>
							<div className="space-y-2">
								<Label htmlFor="reg-name" className={FIELD_LABEL}>Full name</Label>
								<Input id="reg-name" value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="Richard Hendricks" required className={TALL_INPUT} />
							</div>
							<div className="space-y-2">
								<Label htmlFor="reg-email" className={FIELD_LABEL}>Email</Label>
								<Input id="reg-email" type="email" value={regEmail} onChange={(e) => setRegEmail(e.target.value)} placeholder="you@company.com" required className={TALL_INPUT} />
							</div>
							<div className="space-y-2">
								<Label htmlFor="reg-username" className={FIELD_LABEL}>
									Username <span className="normal-case text-muted-foreground/60">(optional)</span>
								</Label>
								<Input id="reg-username" value={regUsername} onChange={(e) => setRegUsername(e.target.value)} placeholder="richard-hendricks" className={TALL_INPUT} />
							</div>
							<div className="space-y-2">
								<Label htmlFor="reg-password" className={FIELD_LABEL}>Password</Label>
								<div className="relative">
									<Input
										id="reg-password"
										type={showPassword ? "text" : "password"}
										value={regPassword}
										onChange={(e) => {
											setRegPassword(e.target.value);
											setRegPasswordTouched(true);
										}}
										placeholder="At least 12 characters"
										required
										className={cn(
											TALL_INPUT,
											"pr-10",
											regPasswordTouched && regPassword
												? regPasswordStrong
													? "border-success focus-visible:ring-success"
													: "border-destructive focus-visible:ring-destructive"
												: "",
										)}
									/>
									<button
										type="button"
										tabIndex={-1}
										className="absolute right-0 top-0 flex h-full w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
										onClick={() => setShowPassword(!showPassword)}
									>
										{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
									</button>
								</div>
								{regPasswordTouched && regPassword && (
									<ul className="mt-2 space-y-1">
										{PASSWORD_RULES.map((rule) => {
											const ok = rule.test(regPassword);
											return (
												<li
													key={rule.id}
													className={`flex items-center gap-1.5 text-xs ${ok ? "text-success" : "text-muted-foreground"}`}
												>
													<span>{ok ? "✓" : "○"}</span>
													{rule.label}
												</li>
											);
										})}
									</ul>
								)}
							</div>
							<div className="space-y-2">
								<Label htmlFor="reg-confirm-password" className={FIELD_LABEL}>Confirm password</Label>
								<Input
									id="reg-confirm-password"
									type={showPassword ? "text" : "password"}
									value={regConfirmPassword}
									onChange={(e) => setRegConfirmPassword(e.target.value)}
									placeholder="Repeat your password"
									required
									className={cn(
										TALL_INPUT,
										regConfirmPassword
											? regPasswordsMatch
												? "border-success focus-visible:ring-success"
												: "border-destructive focus-visible:ring-destructive"
											: "",
									)}
								/>
								{regConfirmPassword && !regPasswordsMatch && (
									<p className="mt-1 text-xs text-destructive">Passwords do not match</p>
								)}
							</div>

							{error && (
								<div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
									<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
									<span>{error}</span>
								</div>
							)}

							<Button
								type="submit"
								disabled={loading || configLoading || !selfRegistrationEnabled || !regPasswordStrong || !regPasswordsMatch}
								className={CTA_BUTTON}
							>
								{loading ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<>
										Create account
										<ArrowRight className="ml-2 h-4 w-4" />
									</>
								)}
							</Button>

							<p className="text-center text-xs text-muted-foreground/60">
								You will start with standard user permissions.
							</p>
						</form>
					)}
				</div>
			</div>

			{/* ── Visual panel: slides left in login mode ────────────────── */}
			<div
				className={cn(
					"relative hidden overflow-hidden transition-transform duration-700 ease-in-out lg:block lg:w-1/2",
					isLogin ? "lg:-translate-x-full" : "lg:translate-x-0",
				)}
			>
				<img
					src="/images/auth-side.jpg"
					alt=""
					className="absolute inset-0 h-full w-full object-cover"
				/>
			</div>
		</div>
	);
}
