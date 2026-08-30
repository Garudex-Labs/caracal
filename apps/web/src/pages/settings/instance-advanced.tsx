// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// The full server configuration catalog, rendered from the server's settings
// schema. Sections that have purpose-built UIs elsewhere (branding, insights,
// telemetry policy, retention) are filtered out here so every setting has
// exactly one home.

import { useCallback, useMemo, useState } from "react";
import {
	Activity,
	AlertTriangle,
	Database,
	HelpCircle,
	Loader2,
	Package,
	Pencil,
	Power,
	Save,
	Settings,
	Shield,
	ShieldAlert,
	Trash2,
	X,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useHelp } from "@/components/help/help-context";
import { SETTING_DOCS, SECTION_DOCS } from "@/lib/docs-map";
import { useAdminSettings, useAdminSettingsSchema, useRestartStatus } from "@/hooks/use-api";
import { useHarnesses } from "@/hooks/use-harnesses";
import { useRoleGuard } from "@/hooks/use-role-guard";
import type { AdminSetting, AdminSettingDef, AdminSettingSection } from "@/lib/types";
import { admin } from "@/lib/api";
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
import { PickerSelect } from "@/components/ui/picker-select";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { ErrorState } from "@/components/shared/error-state";
import { RestartStatusControl } from "@/components/settings/restart-status";
import { SectionHelpButton } from "@/components/settings/section-help";
import { SettingsPage } from "@/components/settings/settings-shell";

// Sensitive keys that should never be displayed in plaintext.
// The server enforces this too (returns **REDACTED** for these keys),
// but we keep the set here for UI affordances (revoke button, write-only input).
const SENSITIVE_KEYS = new Set([
	"insights.api_key",
	"oauth.client_secret",
	"saml.idp_x509_cert",
	"saml.sp_key_encryption_password",
]);

const REDACTED_VALUE = "**REDACTED**";

// Sections and keys that already have purpose-built UIs on other settings pages.
const EXCLUDED_SECTION_IDS = new Set(["insights", "sso"]);
const EXCLUDED_KEYS = new Set([
	"security.trace_privacy",
	"registry.registered_agents_only",
	"danger.purge_traces_insights",
]);

function isExcludedKey(key: string): boolean {
	return EXCLUDED_KEYS.has(key) || key.startsWith("retention.") || key.startsWith("branding.");
}

const SECTION_ICONS: Record<string, React.ReactNode> = {
	danger: <AlertTriangle className="h-3.5 w-3.5" />,
	deployment: <Shield className="h-3.5 w-3.5" />,
	security: <ShieldAlert className="h-3.5 w-3.5" />,
	jwt: <Shield className="h-3.5 w-3.5" />,
	resource: <Database className="h-3.5 w-3.5" />,
	data: <Database className="h-3.5 w-3.5" />,
	registry: <Package className="h-3.5 w-3.5" />,
	observability: <Activity className="h-3.5 w-3.5" />,
	misc: <Settings className="h-3.5 w-3.5" />,
};

function sectionIcon(section: AdminSettingSection) {
	return SECTION_ICONS[section.id] ?? <Settings className="h-3.5 w-3.5" />;
}

function splitHarnessList(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function joinHarnessList(values: string[]): string {
	return Array.from(new Set(values)).join(",");
}

function getHarnessLabel(harnesses: { name: string; display_name: string }[], value: string): string {
	return harnesses.find((harness) => harness.name === value)?.display_name ?? value;
}

function HarnessAllowlistEditor({
	value,
	onChange,
	harnesses,
}: {
	value: string;
	onChange: (value: string) => void;
	harnesses: { name: string; display_name: string }[];
}) {
	const selected = splitHarnessList(value);
	const available = harnesses.filter((harness) => !selected.includes(harness.name));

	const addHarness = (harness: string) => {
		const next = harness.trim();
		if (!next) return;
		onChange(joinHarnessList([...selected, next]));
	};

	const removeHarness = (harness: string) => {
		onChange(joinHarnessList(selected.filter((item) => item !== harness)));
	};

	return (
		<div className="flex-1 space-y-2">
			<div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1">
				{selected.length === 0 ? (
					<span className="text-xs text-muted-foreground">All supported harnesses</span>
				) : (
					selected.map((harness) => (
						<span key={harness} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground">
							{getHarnessLabel(harnesses, harness)}
							<button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => removeHarness(harness)}>
								<X className="h-3 w-3" />
							</button>
						</span>
					))
				)}
			</div>
			<div className="flex items-center gap-2">
				<PickerSelect
					value=""
					onValueChange={addHarness}
					placeholder={selected.length === 0 ? "Restrict to specific harnesses" : "Add harness"}
					className="flex-1"
					inputClassName="h-8 text-sm"
					emptyLabel="All listed harnesses selected"
					options={available.map((harness) => ({ value: harness.name, label: harness.display_name }))}
				/>
				{selected.length > 0 && (
					<Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => onChange("")}>Allow all</Button>
				)}
			</div>
		</div>
	);
}

function RestartRequiredMark() {
	return (
		<span
			className="inline-flex items-center gap-1 text-[11px] font-normal text-warning"
			title="Changing this setting requires an API restart"
		>
			<Power className="h-3 w-3" aria-hidden="true" />
			Restart
		</span>
	);
}

function SettingHelpIcon({ settingKey, openHelp }: { settingKey: string; openHelp: (key?: string) => boolean }) {
	if (!SETTING_DOCS[settingKey]) return null;
	return (
		<button
			type="button"
			className="absolute right-2 top-2 text-muted-foreground/40 transition-colors hover:text-foreground"
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				openHelp(settingKey);
			}}
			aria-label="Open setting help"
		>
			<HelpCircle className="h-4.5 w-4.5" />
		</button>
	);
}

export default function AdvancedSettingsPage() {
	const { ready } = useRoleGuard("operator");
	const queryClient = useQueryClient();
	const {
		data: settings,
		isLoading,
		isError,
		error,
		refetch,
	} = useAdminSettings();
	const { data: settingsSchema = [] } = useAdminSettingsSchema();
	const { refetch: refetchRestartStatus } = useRestartStatus();
	const { data: harnesses = [] } = useHarnesses();
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [editingValue, setEditingValue] = useState("");
	const [revokeConfirmKey, setRevokeConfirmKey] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// Help mode: modifier key + click opens contextual docs (provided by HelpProvider)
	const { helpActive, openHelp: openHelpCtx } = useHelp();
	const [helpBannerDismissed, setHelpBannerDismissed] = useState(() =>
		sessionStorage.getItem("caracal_help_banner_dismissed") === "1"
	);

	const openHelp = useCallback(
		(settingKey?: string, sectionTitle?: string) => openHelpCtx({ settingKey, sectionTitle }),
		[openHelpCtx],
	);

	/** CSS class applied to setting cards that have docs, when help mode is active */
	const helpTargetClass = (key: string) =>
		helpActive && SETTING_DOCS[key] ? "ring-2 ring-primary/60 cursor-help transition-shadow" : "";

	const entries: AdminSetting[] = (
		Array.isArray(settings)
			? settings.map((s: AdminSetting) => ({ key: s.key, value: s.value, is_sensitive: s.is_sensitive, is_set: s.is_set }))
			: Object.entries(settings ?? {}).map(([k, v]) => ({ key: k, value: String(v) }))
	).filter((e) => !isExcludedKey(e.key));

	const settingSections = useMemo(
		() =>
			settingsSchema
				.filter((section) => !EXCLUDED_SECTION_IDS.has(section.id))
				.map((section) => ({
					...section,
					settings: section.settings.filter((s) => !isExcludedKey(s.key)),
				}))
				.filter((section) => section.settings.length > 0),
		[settingsSchema],
	);

	const settingByKey = useMemo(() => {
		const map = new Map<string, AdminSettingDef>();
		for (const section of settingSections) {
			for (const setting of section.settings) map.set(setting.key, setting);
		}
		return map;
	}, [settingSections]);

	const handleInlineSave = useCallback(async () => {
		if (!editingKey) return;
		setSaving(true);
		try {
			await admin.updateSetting(editingKey, { value: editingValue });
			toast.success(`Saved ${editingKey}`);
			if (editingKey === "misc.harness_allowlist" || editingKey === "misc.default_harness") {
				queryClient.invalidateQueries({ queryKey: ["config", "harnesses"] });
			}
			setEditingKey(null);
			setEditingValue("");
			refetch();
			refetchRestartStatus();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [editingKey, editingValue, queryClient, refetch, refetchRestartStatus]);

	const renderSettingEditor = (key: string) => {
		if (key === "misc.harness_allowlist") {
			return <HarnessAllowlistEditor value={editingValue} onChange={setEditingValue} harnesses={harnesses} />;
		}
		if (key === "misc.default_harness") {
			return (
				<PickerSelect
					value={editingValue || "__none__"}
					onValueChange={(value) => setEditingValue(value === "__none__" ? "" : value)}
					placeholder="Choose default harness"
					className="flex-1"
					inputClassName="h-8 text-sm"
					options={[
						{ value: "__none__", label: "Use first allowed harness" },
						...harnesses.map((harness) => ({ value: harness.name, label: harness.display_name })),
					]}
				/>
			);
		}
		return (
			<Input
				value={editingValue}
				onChange={(e) => setEditingValue(e.target.value)}
				placeholder={settingByKey.get(key)?.default || "Enter value..."}
				className="h-8 flex-1 font-mono text-sm"
				autoFocus
				onKeyDown={(e) => {
					if (e.key === "Enter") handleInlineSave();
					if (e.key === "Escape") {
						setEditingKey(null);
						setEditingValue("");
					}
				}}
			/>
		);
	};

	/** One setting card: dashed placeholder, read view, or inline editor. */
	const renderSettingCard = (d: AdminSettingDef) => {
		const existing = entries.find((e) => e.key === d.key);
		const isEditing = editingKey === d.key;
		if (isEditing) {
			return (
				<div key={d.key} className={`rounded-md border-2 border-primary/50 bg-card p-3 ${helpTargetClass(d.key)}`}>
					<div className="mb-2 flex items-center gap-2">
						<span className="text-sm font-semibold text-foreground">{d.label}</span>
						{d.restart_required && <RestartRequiredMark />}
					</div>
					<div className="flex items-center gap-2">
						{renderSettingEditor(d.key)}
						<Button size="sm" className="h-8" onClick={handleInlineSave} disabled={saving}>
							{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
						</Button>
						<Button size="sm" variant="ghost" className="h-8" onClick={() => { setEditingKey(null); setEditingValue(""); }}>
							<X className="h-3.5 w-3.5" />
						</Button>
					</div>
				</div>
			);
		}
		if (existing && existing.value) {
			const isSensitive = existing.is_sensitive || SENSITIVE_KEYS.has(d.key);
			const isSet = existing.is_set ?? !!existing.value;
			return (
				<div
					key={d.key}
					className={`relative rounded-md border-2 border-border bg-card p-3 ${helpTargetClass(d.key)}`}
					onClick={(e) => {
						if ((e.ctrlKey || e.metaKey) && openHelp(d.key)) {
							e.preventDefault();
							e.stopPropagation();
						}
					}}
				>
					<SettingHelpIcon settingKey={d.key} openHelp={openHelp} />
					<div className="flex items-center gap-2 pr-6">
						<span className="text-sm font-semibold text-foreground">{d.label}</span>
						{d.restart_required && <RestartRequiredMark />}
					</div>
					<div className="mt-1.5 flex items-center gap-2">
						<span className="flex-1 truncate font-mono text-xs text-foreground/70">
							{isSensitive ? (isSet ? REDACTED_VALUE : "Not set") : existing.value}
						</span>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 w-6 p-0"
							onClick={() => {
								setEditingKey(d.key);
								setEditingValue(isSensitive ? "" : (existing?.value ?? ""));
							}}
						>
							<Pencil className="h-3 w-3 text-muted-foreground" />
						</Button>
						{isSensitive && isSet ? (
							<Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setRevokeConfirmKey(d.key)}>
								<Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
							</Button>
						) : (
							<Button
								variant="ghost"
								size="sm"
								className="h-6 w-6 p-0"
								onClick={async () => {
									await admin.updateSetting(d.key, { value: "" });
									refetch();
									refetchRestartStatus();
									toast.success(`Cleared ${d.label}`);
								}}
							>
								<Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
							</Button>
						)}
					</div>
				</div>
			);
		}
		return (
			<button
				key={d.key}
				type="button"
				onClick={(e) => {
					if ((e.ctrlKey || e.metaKey) && openHelp(d.key)) {
						e.preventDefault();
						return;
					}
					setEditingKey(d.key);
					setEditingValue("");
				}}
				className={`relative rounded-md border-2 border-dashed border-border/80 p-3 text-left transition-colors hover:border-primary/40 hover:bg-background ${helpTargetClass(d.key)}`}
			>
				<SettingHelpIcon settingKey={d.key} openHelp={openHelp} />
				<div className="flex items-center gap-2 pr-6">
					<span className="text-sm font-semibold text-foreground/60">+ {d.label}</span>
					{d.restart_required && <RestartRequiredMark />}
				</div>
			</button>
		);
	};

	if (!ready) return null;

	return (
		<div className="mx-auto w-full max-w-6xl p-6">
			<SettingsPage
				title="Advanced"
				description="Server configuration catalog. Values apply live unless marked as requiring a restart."
				scope="instance"
				actions={<RestartStatusControl onRestarted={refetch} />}
			>
			{isLoading ? (
				<TableSkeleton rows={5} cols={2} />
			) : isError ? (
				<ErrorState message={error?.message} onRetry={() => refetch()} />
			) : (
				<div className="space-y-8">
					{/* Help mode hint banner */}
					{!helpBannerDismissed && (
						<div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5">
							<HelpCircle className="h-3.5 w-3.5 shrink-0 text-primary" />
							<span className="text-sm text-foreground/80">
								Use guide icons for docs. Hold {navigator.platform?.includes("Mac") ? "Command" : "Ctrl"} and
								click highlighted settings for field-level help.
							</span>
							<button
								type="button"
								className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
								onClick={() => {
									setHelpBannerDismissed(true);
									sessionStorage.setItem("caracal_help_banner_dismissed", "1");
								}}
							>
								<X className="h-3.5 w-3.5" />
							</button>
						</div>
					)}

					{/* Live sections */}
					{settingSections.filter((s) => !s.danger).map((section) => (
						<section key={section.id} id={section.id} className="scroll-mt-28">
							<h3
								className={`mb-1 flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-wider text-foreground/80 ${
									helpActive && SECTION_DOCS[section.title]
										? "cursor-help rounded-sm ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
										: ""
								}`}
								onClick={(event) => {
									if ((event.ctrlKey || event.metaKey) && openHelp(undefined, section.title)) {
										event.preventDefault();
									}
								}}
							>
								{sectionIcon(section)}
								{section.title}
								<SectionHelpButton sectionTitle={section.title} />
							</h3>
							{section.description && <p className="mb-3 text-xs text-foreground/60">{section.description}</p>}
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								{section.settings.map(renderSettingCard)}
							</div>
						</section>
					))}

					{/* Danger Zone */}
					{settingSections.some((s) => s.danger) && (
						<section id="danger" className="scroll-mt-28">
							<div className="border-t-2 border-warning/30 pt-6">
								<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-warning">
									<AlertTriangle className="h-4 w-4" />
									Danger Zone
								</h2>
								<p className="mb-4 text-xs text-foreground/60">
									These settings can affect authentication, security, and data integrity.
								</p>
								<div className="space-y-4">
									{settingSections.filter((s) => s.danger).map((section) => (
										<details key={section.id} className="group rounded-md border-2 border-border/70 border-l-4 border-l-warning/60 bg-card">
											<summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 transition-colors hover:bg-muted/30">
												{sectionIcon(section)}
												<span className="flex-1 text-sm font-semibold text-foreground/80">{section.title}</span>
												<SectionHelpButton sectionTitle={section.title} />
												<span className="text-[10px] font-medium text-warning">CAUTION</span>
											</summary>
											<div className="px-4 pb-4 pt-1">
												{section.description && (
													<p className="mb-3 text-xs text-foreground/60">{section.description}</p>
												)}
												<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
													{section.settings.map(renderSettingCard)}
												</div>
											</div>
										</details>
									))}
								</div>
							</div>
						</section>
					)}
				</div>
			)}

			<Dialog open={revokeConfirmKey !== null} onOpenChange={(open) => { if (!open) setRevokeConfirmKey(null); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Revoke secret</DialogTitle>
						<DialogDescription>
							This will permanently delete the stored value for <strong>{revokeConfirmKey}</strong>.
							Any features depending on this credential will stop working immediately. This cannot be
							undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setRevokeConfirmKey(null)}>Cancel</Button>
						<Button
							variant="destructive"
							onClick={async () => {
								const key = revokeConfirmKey;
								if (!key) return;
								try {
									await admin.revokeSetting(key);
									refetch();
									refetchRestartStatus();
									toast.success(`Revoked ${key}`);
								} catch (e: unknown) {
									toast.error(e instanceof Error ? e.message : "Failed to revoke setting");
								} finally {
									setRevokeConfirmKey(null);
								}
							}}
						>
							Revoke
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			</SettingsPage>
		</div>
	);
}
