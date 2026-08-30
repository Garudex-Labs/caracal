// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Account protection: password rotation, passkeys, and active sessions.
// Everything here talks to the Better Auth identity service, not the registry API.

import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, KeyRound, Loader2, Mail, MonitorSmartphone, Plus, ShieldCheck, Smartphone, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import {
	accountPasswordState,
	providerLabel,
	type LinkedAccount,
} from "@/lib/auth-methods";
import type { AccountDevice, AccountDevicesResponse } from "@/lib/types";
import { useDeploymentConfig } from "@/hooks/use-deployment-config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	SettingRow,
	SettingsCard,
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-shell";

// ── Shared bits ─────────────────────────────────────────────────────────────

function formatDate(value: string | Date | null | undefined): string {
	if (!value) return "–";
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString();
}

function SectionStatus({ loading, error, children }: { loading: boolean; error?: string | null; children?: React.ReactNode }) {
	if (loading) {
		return (
			<div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
				<Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
			</div>
		);
	}
	if (error) {
		return <p className="px-4 py-3 text-xs text-destructive">{error}</p>;
	}
	return <>{children}</>;
}

// ── Password ────────────────────────────────────────────────────────────────

// Better Auth enforces minPasswordLength: 12 on the identity service, so the
// client-side rules must not promise acceptance below that.
const PASSWORD_RULES = [
	{ id: "len", label: "At least 12 characters", test: (p: string) => p.length >= 12 },
	{ id: "upper", label: "One uppercase letter", test: (p: string) => /[A-Z]/.test(p) },
	{ id: "digit", label: "One number", test: (p: string) => /[0-9]/.test(p) },
	{ id: "special", label: "One special character", test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

function passwordIsStrong(p: string) {
	return PASSWORD_RULES.every((r) => r.test(p));
}

// The form used once we know a local credential exists. Kept separate so it
// only mounts for accounts that can actually change a password.
function ChangePasswordForm() {
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [saving, setSaving] = useState(false);
	const [touched, setTouched] = useState(false);

	const strong = passwordIsStrong(newPassword);
	const matches = newPassword === confirmPassword;
	const canSubmit = currentPassword && strong && matches && confirmPassword;

	const handleSubmit = useCallback(async () => {
		if (!strong) {
			toast.error("Password does not meet the requirements");
			return;
		}
		if (!matches) {
			toast.error("Passwords do not match");
			return;
		}
		setSaving(true);
		try {
			const { error } = await authClient.changePassword({
				currentPassword,
				newPassword,
				revokeOtherSessions: true,
			});
			if (error) throw new Error(error.message || "Failed to change password");
			toast.success("Password changed. Other sessions were signed out.");
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
			setTouched(false);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to change password");
		} finally {
			setSaving(false);
		}
	}, [currentPassword, newPassword, strong, matches]);

	return (
		<div className="space-y-3 px-4 py-3">
			<div>
				<label htmlFor="current-password" className="mb-1 block text-xs text-muted-foreground">
					Current password
				</label>
				<Input
					id="current-password"
					type="password"
					autoComplete="current-password"
					value={currentPassword}
					onChange={(e) => setCurrentPassword(e.target.value)}
					className="h-8 max-w-sm text-sm"
				/>
			</div>
			<div>
				<label htmlFor="new-password" className="mb-1 block text-xs text-muted-foreground">
					New password
				</label>
				<Input
					id="new-password"
					type="password"
					autoComplete="new-password"
					value={newPassword}
					onChange={(e) => {
						setNewPassword(e.target.value);
						setTouched(true);
					}}
					className={`h-8 max-w-sm text-sm ${
						touched && newPassword
							? strong
								? "border-success focus-visible:ring-success"
								: "border-destructive focus-visible:ring-destructive"
							: ""
					}`}
				/>
				{touched && newPassword && (
					<ul className="mt-2 space-y-1">
						{PASSWORD_RULES.map((rule) => {
							const ok = rule.test(newPassword);
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
			<div>
				<label htmlFor="confirm-password" className="mb-1 block text-xs text-muted-foreground">
					Confirm new password
				</label>
				<Input
					id="confirm-password"
					type="password"
					autoComplete="new-password"
					value={confirmPassword}
					onChange={(e) => setConfirmPassword(e.target.value)}
					className={`h-8 max-w-sm text-sm ${
						confirmPassword
							? matches
								? "border-success focus-visible:ring-success"
								: "border-destructive focus-visible:ring-destructive"
							: ""
					}`}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleSubmit();
					}}
				/>
				{confirmPassword && !matches && (
					<p className="mt-1 text-xs text-destructive">Passwords do not match</p>
				)}
			</div>
			<Button size="sm" className="h-8" onClick={handleSubmit} disabled={saving || !canSubmit}>
				{saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
				Update password
			</Button>
			<p className="text-[11px] text-muted-foreground">
				You will be asked for your current password. Every other signed-in session is
				signed out when the password changes.
			</p>
		</div>
	);
}

// Shown when the account has no local credential: password management belongs
// to the external provider(s). Better Auth's server-only setPassword is
// reached through the recommended password-reset flow when email delivery is
// available, which links a credential account.
function ProviderManagedNotice({
	email,
	providers,
	emailDelivery,
}: {
	email: string;
	providers: LinkedAccount[];
	emailDelivery: boolean;
}) {
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState(false);

	const names = providers.map((p) => providerLabel(p.providerId));
	const methodList =
		names.length === 0
			? "an external identity provider"
			: names.length === 1
				? names[0]
				: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

	const sendSetup = useCallback(async () => {
		if (!email) {
			toast.error("Your account has no email address to send a link to.");
			return;
		}
		setSending(true);
		try {
			const { error } = await authClient.requestPasswordReset({
				email,
				redirectTo: "/reset-password",
			});
			if (error) throw new Error(error.message || "Could not send the setup email.");
			setSent(true);
			toast.success("If email delivery is configured, a link to set a password is on its way.");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Could not send the setup email.");
		} finally {
			setSending(false);
		}
	}, [email]);

	return (
		<div className="space-y-3 px-4 py-3">
			<div className="flex items-start gap-2.5">
				<ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
				<div className="space-y-1">
					<p className="text-sm">
						This account signs in with {methodList}. There is no local password to
						change &mdash; credentials are managed by your identity provider.
					</p>
					{providers.length > 0 && (
						<div className="flex flex-wrap gap-1.5 pt-1">
							{providers.map((p) => (
								<Badge
									key={p.id ?? p.providerId}
									variant="outline"
									className="border-border px-1.5 py-0 text-[10px] text-muted-foreground"
								>
									{providerLabel(p.providerId)}
								</Badge>
							))}
						</div>
					)}
				</div>
			</div>
			{emailDelivery && email ? (
				<div className="space-y-2 border-t border-border pt-3">
					<p className="text-xs text-muted-foreground">
						Want to sign in with a password too? We can email you a link to set one
						without removing your existing sign-in methods.
					</p>
					<Button
						size="sm"
						variant="outline"
						className="h-8"
						onClick={sendSetup}
						disabled={sending || sent}
					>
						{sending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
						<Mail className="mr-1.5 h-3.5 w-3.5" />
						{sent ? "Setup link sent" : "Email me a link to set a password"}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function PasswordSection() {
	const { data: session } = authClient.useSession();
	const email = session?.user?.email ?? "";
	// magic_links in the capability descriptor is exactly "email delivery works",
	// which is what the set-a-password reset flow depends on.
	const { magicLinksEnabled } = useDeploymentConfig();

	// Better Auth is the authoritative source for linked authentication
	// identities. A local password exists iff a "credential" account is present;
	// we never infer this from the last login method or environment flags.
	const accounts = useQuery({
		queryKey: ["auth", "accounts"],
		queryFn: async () => {
			const { data, error } = await authClient.listAccounts();
			if (error) throw new Error(error.message || "Could not load account providers");
			return (data ?? []) as LinkedAccount[];
		},
	});

	const list = accounts.data ?? [];
	const { hasPassword, externalProviders } = accountPasswordState(list);

	return (
		<SettingsSection
			id="password"
			title="Password"
			description="How you sign in to your account and, where supported, manage a local password."
		>
			<SettingsCard>
				<SectionStatus
					loading={accounts.isLoading}
					// Fail safe: if we cannot determine the account's real credential
					// state, show the error rather than a form that would fail.
					error={accounts.isError ? accounts.error.message : null}
				>
					{hasPassword ? (
						<ChangePasswordForm />
					) : (
						<ProviderManagedNotice
							email={email}
							providers={externalProviders}
							emailDelivery={magicLinksEnabled}
						/>
					)}
				</SectionStatus>
			</SettingsCard>
		</SettingsSection>
	);
}

// ── Passkeys ────────────────────────────────────────────────────────────────

type PasskeyItem = {
	id: string;
	name?: string | null;
	deviceType?: string | null;
	createdAt?: string | Date | null;
};

function PasskeysSection() {
	const qc = useQueryClient();
	const [addOpen, setAddOpen] = useState(false);
	const [passkeyName, setPasskeyName] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<PasskeyItem | null>(null);

	const passkeys = useQuery({
		queryKey: ["auth", "passkeys"],
		queryFn: async () => {
			const { data, error } = await authClient.passkey.listUserPasskeys();
			if (error) throw new Error(error.message || "Could not load passkeys");
			return (data ?? []) satisfies PasskeyItem[];
		},
	});

	const add = useMutation({
		mutationFn: async (name: string) => {
			const result = await authClient.passkey.addPasskey(name ? { name } : {});
			if (result?.error) throw new Error(result.error.message || "Failed to register passkey");
		},
		onSuccess: () => {
			toast.success("Passkey registered");
			setAddOpen(false);
			setPasskeyName("");
			qc.invalidateQueries({ queryKey: ["auth", "passkeys"] });
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const remove = useMutation({
		mutationFn: async (id: string) => {
			const { error } = await authClient.passkey.deletePasskey({ id });
			if (error) throw new Error(error.message || "Failed to remove passkey");
		},
		onSuccess: () => {
			toast.success("Passkey removed");
			setDeleteTarget(null);
			qc.invalidateQueries({ queryKey: ["auth", "passkeys"] });
		},
		onError: (err: Error) => toast.error(err.message),
	});

	return (
		<SettingsSection
			id="passkeys"
			title="Passkeys"
			description="Sign in with a device credential instead of a password."
			actions={
				<Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddOpen(true)}>
					<Plus className="mr-1 h-3.5 w-3.5" /> Add passkey
				</Button>
			}
		>
			<SettingsCard>
				<SectionStatus
					loading={passkeys.isLoading}
					error={passkeys.isError ? passkeys.error.message : null}
				>
					{(passkeys.data ?? []).length === 0 ? (
						<p className="px-4 py-3 text-xs text-muted-foreground">
							No passkeys registered. Add one to enable passwordless sign-in on this device.
						</p>
					) : (
						(passkeys.data ?? []).map((pk) => (
							<SettingRow
								key={pk.id}
								label={
									<span className="flex items-center gap-2">
										<KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
										{pk.name || "Unnamed passkey"}
									</span>
								}
								description={`${pk.deviceType === "multiDevice" ? "Synced" : "Device-bound"} · Added ${formatDate(pk.createdAt)}`}
							>
								<Button
									variant="ghost"
									size="sm"
									className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
									aria-label={`Remove passkey ${pk.name || pk.id}`}
									onClick={() => setDeleteTarget(pk)}
								>
									<Trash2 className="h-3.5 w-3.5" />
								</Button>
							</SettingRow>
						))
					)}
				</SectionStatus>
			</SettingsCard>

			<Dialog open={addOpen} onOpenChange={(open) => { if (!open) setAddOpen(false); }}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Add passkey</DialogTitle>
						<DialogDescription>
							Your browser will prompt you to create a credential on this device or a security key.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<label htmlFor="passkey-name" className="text-xs font-medium text-muted-foreground">
							Name (optional)
						</label>
						<Input
							id="passkey-name"
							placeholder="e.g. Work laptop"
							value={passkeyName}
							onChange={(e) => setPasskeyName(e.target.value)}
							className="h-8 text-sm"
							autoFocus
							onKeyDown={(e) => {
								if (e.key === "Enter") add.mutate(passkeyName.trim());
							}}
						/>
					</div>
					<DialogFooter>
						<Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
							Cancel
						</Button>
						<Button size="sm" onClick={() => add.mutate(passkeyName.trim())} disabled={add.isPending}>
							{add.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
							Continue
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Remove passkey</DialogTitle>
						<DialogDescription>
							<strong>{deleteTarget?.name || "This passkey"}</strong> will no longer work for
							sign-in. This cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}
							disabled={remove.isPending}
						>
							{remove.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
							Remove
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SettingsSection>
	);
}

// ── Sessions ────────────────────────────────────────────────────────────────

const AUTH_BASE =
	typeof window !== "undefined" ? `${window.location.origin}/api/auth` : "/api/auth";
const DEVICE_PAGE_SIZE = 5;

type DeviceMutationResult = AccountDevicesResponse & { ok: boolean; revoked: number };

// Raw fetch against the identity service is the sanctioned exception for auth
// calls; the device API lives beside Better Auth's own session routes.
async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${AUTH_BASE}${path}`, {
		credentials: "include",
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		...init,
	});
	if (!res.ok) {
		let message = `Request failed (${res.status})`;
		try {
			const body = (await res.json()) as { error?: string };
			if (body?.error) message = body.error;
		} catch {
			/* non-JSON body */
		}
		throw new Error(message);
	}
	return (await res.json()) as T;
}

function relativeTime(value: string): string {
	const then = new Date(value).getTime();
	if (Number.isNaN(then)) return "–";
	const diff = Date.now() - then;
	if (diff < 60_000) return "just now";
	const mins = Math.floor(diff / 60_000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(then).toLocaleDateString();
}

function DeviceIcon({ form }: { form: AccountDevice["form"] }) {
	const cls = "h-4 w-4 text-muted-foreground";
	if (form === "cli") return <Terminal className={cls} />;
	if (form === "mobile") return <Smartphone className={cls} />;
	return <MonitorSmartphone className={cls} />;
}

function DeviceHistoryDialog({
	device,
	retentionDays,
	onClose,
	onRevokeSession,
	onRevokeDevice,
	revokingSessionId,
	revokingDevice,
}: {
	device: AccountDevice | null;
	retentionDays: number;
	onClose: () => void;
	onRevokeSession: (sessionId: string) => void;
	onRevokeDevice: (device: AccountDevice) => void;
	revokingSessionId: string | null;
	revokingDevice: boolean;
}) {
	const hasRevocable = device?.sessions.some((s) => !s.current) ?? false;
	return (
		<Dialog open={!!device} onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{device && <DeviceIcon form={device.form} />}
						{device?.label ?? "Device"}
						{device?.current && (
							<Badge variant="outline" className="border-success/40 px-1.5 py-0 text-[10px] text-success">
								This device
							</Badge>
						)}
					</DialogTitle>
					<DialogDescription>
						{device?.os} · session history for the last {retentionDays} days. Older sessions are not retained.
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-72 space-y-1.5 overflow-y-auto">
					{device?.sessions.length ? (
						device.sessions.map((s) => (
							<div
								key={s.id}
								className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
							>
								<div className="min-w-0">
									<div className="flex items-center gap-2 text-xs font-medium text-foreground">
										{s.current ? "Current session" : "Session"}
										<Badge
											variant="outline"
											className={
												s.active
													? "border-success/40 px-1.5 py-0 text-[10px] text-success"
													: "px-1.5 py-0 text-[10px] text-muted-foreground"
											}
										>
											{s.active ? "Active" : "Expired"}
										</Badge>
									</div>
									<div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
										{s.ipAddress || "unknown IP"} · last active {relativeTime(s.lastActiveAt)} · expires{" "}
										{formatDate(s.expiresAt)}
									</div>
								</div>
								{!s.current && (
									<Button
										variant="ghost"
										size="sm"
										className="h-7 shrink-0 text-xs text-muted-foreground hover:text-destructive"
										onClick={() => onRevokeSession(s.id)}
										disabled={revokingSessionId === s.id}
									>
										{revokingSessionId === s.id && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
										Revoke
									</Button>
								)}
							</div>
						))
					) : (
						<p className="px-1 py-2 text-xs text-muted-foreground">No sessions in the retention window.</p>
					)}
				</div>
				<DialogFooter>
					<Button variant="ghost" size="sm" onClick={onClose}>
						Close
					</Button>
					{hasRevocable && device && (
						<Button
							variant="destructive"
							size="sm"
							onClick={() => onRevokeDevice(device)}
							disabled={revokingDevice}
						>
							{revokingDevice && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
							{device.current ? "Sign out other sessions here" : "Revoke this device"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function SessionsSection() {
	const qc = useQueryClient();
	const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);
	const [devicePage, setDevicePage] = useState(1);

	const devicesQuery = useQuery({
		queryKey: ["auth", "devices"],
		queryFn: () => authFetch<AccountDevicesResponse>("/devices"),
	});

	const setDevicesData = (data: AccountDevicesResponse) => {
		qc.setQueryData<AccountDevicesResponse>(["auth", "devices"], {
			devices: data.devices,
			retention_days: data.retention_days,
		});
	};

	const invalidate = () => qc.invalidateQueries({ queryKey: ["auth", "devices"] });

	const revokeDevice = useMutation({
		mutationFn: (device: AccountDevice) =>
			authFetch<DeviceMutationResult>(`/devices/${encodeURIComponent(device.deviceId)}/revoke`, {
				method: "POST",
				// Revoking the current device would sign you out; scope it to the
				// other sessions on that device instead.
				body: JSON.stringify(device.current ? { scope: "others" } : {}),
			}),
		onSuccess: (data) => {
			setDevicesData(data);
			toast.success("Device sessions revoked");
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const revokeSession = useMutation({
		mutationFn: (sessionId: string) =>
			authFetch<DeviceMutationResult>(`/device-sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST" }),
		onSuccess: (data) => {
			setDevicesData(data);
			toast.success("Session revoked");
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const revokeOthers = useMutation({
		mutationFn: async () => {
			const { error } = await authClient.revokeOtherSessions();
			if (error) throw new Error(error.message || "Failed to revoke sessions");
		},
		onSuccess: async () => {
			toast.success("All other sessions signed out");
			await invalidate();
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const devices = devicesQuery.data?.devices ?? [];
	const retentionDays = devicesQuery.data?.retention_days ?? 30;
	const pageCount = Math.max(1, Math.ceil(devices.length / DEVICE_PAGE_SIZE));
	const visiblePage = Math.min(devicePage, pageCount);
	const pageStart = (visiblePage - 1) * DEVICE_PAGE_SIZE;
	const pagedDevices = devices.slice(pageStart, pageStart + DEVICE_PAGE_SIZE);
	const openDevice = devices.find((d) => d.deviceId === openDeviceId) ?? null;
	// "Other" activity = any active session that is not the current one, whether
	// on another device or a second session on the current device.
	const hasOthers = devices.some((d) => d.sessions.some((s) => s.active && !s.current));
	const showPagination = devices.length > DEVICE_PAGE_SIZE;

	return (
		<SettingsSection
			id="sessions"
			title="Active sessions"
			description="Devices signed in to your account. Select a device to see its recent session history."
			actions={
				hasOthers ? (
					<Button
						size="sm"
						variant="outline"
						className="h-7 text-xs"
						onClick={() => revokeOthers.mutate()}
						disabled={revokeOthers.isPending}
					>
						{revokeOthers.isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
						Sign out other sessions
					</Button>
				) : undefined
			}
		>
			<SettingsCard>
				<SectionStatus
					loading={devicesQuery.isLoading}
					error={devicesQuery.isError ? (devicesQuery.error as Error).message : null}
				>
					{devices.length === 0 ? (
						<p className="px-4 py-3 text-xs text-muted-foreground">No active devices found.</p>
					) : (
						<>
							<div className="h-92 overflow-hidden sm:h-73">
								<div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto] gap-3 border-b border-border px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
									<span>Device / Client</span>
									<span>Current / last active</span>
									<span>Platform</span>
									<span>Recent activity</span>
									<span className="text-right">Actions</span>
								</div>
								{pagedDevices.map((d) => (
									<div
										key={d.deviceId}
										role="button"
										tabIndex={0}
										onClick={() => setOpenDeviceId(d.deviceId)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												setOpenDeviceId(d.deviceId);
											}
										}}
										className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto]"
									>
										<span className="flex min-w-0 items-center gap-2">
											<DeviceIcon form={d.form} />
											<span className="truncate text-sm font-medium text-foreground">{d.label}</span>
											{d.current && (
												<Badge variant="outline" className="border-success/40 px-1.5 py-0 text-[10px] text-success">
													This device
												</Badge>
											)}
										</span>
										<span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
											{d.active ? (
												<>
													<span className="h-1.5 w-1.5 rounded-full bg-success" />
													{d.current ? "Active now" : `Active · ${relativeTime(d.lastActiveAt)}`}
												</>
											) : (
												<>Last active {relativeTime(d.lastActiveAt)}</>
											)}
										</span>
										<span className="hidden text-xs text-muted-foreground sm:block">{d.os}</span>
										<span className="hidden text-xs text-muted-foreground sm:block">
											{d.activeSessionCount} active · {d.sessionCount} total
										</span>
										<span className="flex items-center justify-end gap-1">
											{!d.current && (
												<Button
													variant="ghost"
													size="sm"
													className="h-7 text-xs text-muted-foreground hover:text-destructive"
													onClick={(e) => {
														e.stopPropagation();
														revokeDevice.mutate(d);
													}}
													disabled={revokeDevice.isPending}
												>
													Revoke
												</Button>
											)}
											<ChevronRight className="h-4 w-4 text-muted-foreground" />
										</span>
									</div>
								))}
							</div>
							<div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
								<span>
									{devices.length} device{devices.length === 1 ? "" : "s"}
									{showPagination ? ` · page ${visiblePage} of ${pageCount}` : ""}
								</span>
								{showPagination && (
									<div className="flex items-center gap-1">
										<Button
											variant="ghost"
											size="sm"
											className="h-7 w-7 p-0"
											onClick={() => setDevicePage(Math.max(1, visiblePage - 1))}
											disabled={visiblePage === 1}
											aria-label="Previous devices page"
										>
											<ChevronLeft className="h-4 w-4" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											className="h-7 w-7 p-0"
											onClick={() => setDevicePage(Math.min(pageCount, visiblePage + 1))}
											disabled={visiblePage === pageCount}
											aria-label="Next devices page"
										>
											<ChevronRight className="h-4 w-4" />
										</Button>
									</div>
								)}
							</div>
						</>
					)}
				</SectionStatus>
			</SettingsCard>

			<DeviceHistoryDialog
				device={openDevice}
				retentionDays={retentionDays}
				onClose={() => setOpenDeviceId(null)}
				onRevokeSession={(id) => revokeSession.mutate(id)}
				onRevokeDevice={(device) => revokeDevice.mutate(device)}
				revokingSessionId={revokeSession.isPending ? (revokeSession.variables as string) : null}
				revokingDevice={revokeDevice.isPending}
			/>
		</SettingsSection>
	);
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function SecuritySettingsPage() {
	const { passkeysEnabled, emailPasswordEnabled } = useDeploymentConfig();

	return (
		<SettingsPage
			title="Security"
			description="Authentication methods and access to your account."
			scope="account"
		>
			{emailPasswordEnabled && <PasswordSection />}
			{passkeysEnabled && <PasskeysSection />}
			<SessionsSection />
		</SettingsPage>
	);
}
