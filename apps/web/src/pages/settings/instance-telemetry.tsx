// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Telemetry policy and data lifecycle for the whole deployment: who can see
// traces, what gets traced, how long data is kept, and the destructive
// escape hatches.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeftRight, HelpCircle, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { admin } from "@/lib/api";
import { useHelp } from "@/components/help/help-context";
import { useRoleGuard } from "@/hooks/use-role-guard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MigrateDialog } from "@/components/settings/migrate/migrate-dialog";
import { SectionHelpButton } from "@/components/settings/section-help";
import {
	SettingRow,
	SettingsCard,
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-shell";

function TracingPolicySection() {
	const [tracePrivacy, setTracePrivacy] = useState(false);
	const [tracePrivacyLoading, setTracePrivacyLoading] = useState(true);
	const [tracePrivacyToggling, setTracePrivacyToggling] = useState(false);
	const [registeredAgentsOnly, setRegisteredAgentsOnly] = useState(false);
	const [registeredAgentsOnlyLoading, setRegisteredAgentsOnlyLoading] = useState(true);
	const [registeredAgentsOnlyToggling, setRegisteredAgentsOnlyToggling] = useState(false);

	useEffect(() => {
		admin
			.getTracePrivacy()
			.then((res) => setTracePrivacy(res.trace_privacy))
			.catch(() => { toast.error("Failed to load trace privacy setting"); })
			.finally(() => setTracePrivacyLoading(false));
		admin
			.getRegisteredAgentsOnly()
			.then((res) => setRegisteredAgentsOnly(res.registered_agents_only))
			.catch(() => { toast.error("Failed to load registered-agents-only setting"); })
			.finally(() => setRegisteredAgentsOnlyLoading(false));
	}, []);

	const handleTracePrivacyToggle = useCallback(async (checked: boolean) => {
		setTracePrivacyToggling(true);
		try {
			const res = await admin.setTracePrivacy(checked);
			setTracePrivacy(res.trace_privacy);
			toast.success(`Trace privacy ${res.trace_privacy ? "enabled" : "disabled"}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update trace privacy");
		} finally {
			setTracePrivacyToggling(false);
		}
	}, []);

	const handleRegisteredAgentsOnlyToggle = useCallback(async (checked: boolean) => {
		setRegisteredAgentsOnlyToggling(true);
		try {
			const res = await admin.setRegisteredAgentsOnly(checked);
			setRegisteredAgentsOnly(res.registered_agents_only);
			toast.success(`Registered agents only ${res.registered_agents_only ? "enabled" : "disabled"}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update setting");
		} finally {
			setRegisteredAgentsOnlyToggling(false);
		}
	}, []);

	return (
		<SettingsSection
			id="trace-privacy"
			title="Tracing policy"
			description="Visibility and scope of session telemetry."
			actions={<SectionHelpButton sectionTitle="Trace Privacy" />}
		>
			<SettingsCard>
				<SettingRow
					label="Restrict trace visibility"
					description="When enabled, all users (including admins) can only see their own traces. Super-admins always retain full visibility across all traces."
				>
					<Switch
						checked={tracePrivacy}
						onCheckedChange={handleTracePrivacyToggle}
						disabled={tracePrivacyLoading || tracePrivacyToggling}
						aria-label="Restrict trace visibility"
					/>
				</SettingRow>
				<div id="registered-agents" className="scroll-mt-28">
					<SettingRow
						label={
							<span className="flex items-center gap-1.5">
								Only trace registered agents
								<SectionHelpButton sectionTitle="Registered Agents Only" />
							</span>
						}
						description="Unstable. When enabled, only registered agents are traced. Unregistered agent activity may be missing from traces."
					>
						<Switch
							checked={registeredAgentsOnly}
							onCheckedChange={handleRegisteredAgentsOnlyToggle}
							disabled={registeredAgentsOnlyLoading || registeredAgentsOnlyToggling}
							aria-label="Only trace registered agents"
						/>
					</SettingRow>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

function RetentionSection() {
	const queryClient = useQueryClient();
	const [retentionEnabled, setRetentionEnabled] = useState(false);
	const [retentionDays, setRetentionDays] = useState<string>("");
	const [scoreRetentionDays, setScoreRetentionDays] = useState<string>("");
	const [maxTraceCount, setMaxTraceCount] = useState<string>("");
	const [retentionGlobal, setRetentionGlobal] = useState(90);
	const [retentionLoading, setRetentionLoading] = useState(true);
	const [retentionSaving, setRetentionSaving] = useState(false);
	const [showConfirm, setShowConfirm] = useState(false);
	const [confirmChecked, setConfirmChecked] = useState(false);
	const [preview, setPreview] = useState<Record<string, number | string> | null>(null);
	const retentionWasEnabled = useRef(false);

	useEffect(() => {
		admin
			.getRetention()
			.then((res) => {
				setRetentionEnabled(res.retention_enabled);
				retentionWasEnabled.current = res.retention_enabled;
				setRetentionDays(res.data_retention_days?.toString() || "");
				setScoreRetentionDays(res.score_retention_days?.toString() || "");
				setMaxTraceCount(res.max_trace_count?.toString() || "");
				setRetentionGlobal(res.global_retention_days);
			})
			.catch(() => { toast.error("Failed to load retention settings"); })
			.finally(() => setRetentionLoading(false));
	}, []);

	const retentionErrors = useMemo(() => {
		const errors: {
			data_retention_days?: string;
			score_retention_days?: string;
			max_trace_count?: string;
			general?: string;
		} = {};
		const days = retentionDays ? parseInt(retentionDays, 10) : null;
		const scoreDays = scoreRetentionDays ? parseInt(scoreRetentionDays, 10) : null;
		const maxCount = maxTraceCount ? parseInt(maxTraceCount, 10) : null;

		if (days !== null && !isNaN(days)) {
			if (days < 7) errors.data_retention_days = "Minimum 7 days";
			else if (retentionGlobal > 0 && days > retentionGlobal)
				errors.data_retention_days = `Cannot exceed global limit of ${retentionGlobal} days`;
		}
		if (scoreDays !== null && !isNaN(scoreDays)) {
			if (scoreDays < 7) errors.score_retention_days = "Minimum 7 days";
			else if (days && scoreDays < days)
				errors.score_retention_days = `Must be ≥ trace retention (${days} days)`;
		}
		if (maxCount !== null && !isNaN(maxCount)) {
			if (maxCount < 1000) errors.max_trace_count = "Minimum 1,000 traces";
		}
		if (retentionEnabled && !days && !maxCount) {
			errors.general = "Set at least one retention threshold to enable";
		}
		return errors;
	}, [retentionDays, scoreRetentionDays, maxTraceCount, retentionEnabled, retentionGlobal]);

	const hasErrors = Object.keys(retentionErrors).length > 0;

	const applyRetention = useCallback(
		async (enabled: boolean, successMessage: string) => {
			const days = retentionDays ? parseInt(retentionDays, 10) : null;
			const scoreDays = scoreRetentionDays ? parseInt(scoreRetentionDays, 10) : null;
			const maxCount = maxTraceCount ? parseInt(maxTraceCount, 10) : null;
			setRetentionSaving(true);
			try {
				const res = await admin.setRetention({
					retention_enabled: enabled,
					data_retention_days: days,
					score_retention_days: scoreDays,
					max_trace_count: maxCount,
				});
				setRetentionEnabled(res.retention_enabled);
				retentionWasEnabled.current = res.retention_enabled;
				setRetentionDays(res.data_retention_days?.toString() || "");
				setScoreRetentionDays(res.score_retention_days?.toString() || "");
				setMaxTraceCount(res.max_trace_count?.toString() || "");
				queryClient.invalidateQueries({ queryKey: ["admin", "retention"] });
				toast.success(successMessage);
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Failed to update retention");
			} finally {
				setRetentionSaving(false);
				setPreview(null);
			}
		},
		[retentionDays, scoreRetentionDays, maxTraceCount, queryClient],
	);

	const handleSave = useCallback(() => {
		const days = retentionDays ? parseInt(retentionDays, 10) : null;
		if (retentionEnabled && !retentionWasEnabled.current && days) {
			setShowConfirm(true);
			admin
				.previewRetention(days)
				.then(setPreview)
				.catch(() => setPreview(null));
			return;
		}
		applyRetention(retentionEnabled, "Retention settings updated");
	}, [retentionEnabled, retentionDays, applyRetention]);

	const handleConfirm = useCallback(() => {
		setShowConfirm(false);
		setConfirmChecked(false);
		applyRetention(true, "Data retention enabled");
	}, [applyRetention]);

	return (
		<SettingsSection
			id="retention"
			title="Data retention"
			description="Automatically purge telemetry older than the configured period."
			actions={<SectionHelpButton sectionTitle="Data Retention" />}
		>
			<SettingsCard>
				<SettingRow
					label="Enable data retention"
					description={`Purges run automatically every 6 hours. Global ceiling: ${
						retentionGlobal > 0 ? `${retentionGlobal} days` : "disabled"
					}.`}
				>
					<Switch
						checked={retentionEnabled}
						onCheckedChange={setRetentionEnabled}
						disabled={retentionLoading}
						aria-label="Enable data retention"
					/>
				</SettingRow>

				{retentionEnabled && (
					<div className="space-y-3 px-4 py-3">
						<div>
							<label className="text-xs text-muted-foreground">Trace retention (days)</label>
							<Input
								type="number"
								min={7}
								max={retentionGlobal > 0 ? retentionGlobal : undefined}
								value={retentionDays}
								onChange={(e) => setRetentionDays(e.target.value)}
								placeholder="e.g. 30"
								className="mt-1 h-8 max-w-50 text-sm"
							/>
							{retentionErrors.data_retention_days && (
								<p className="mt-1 text-xs text-destructive">{retentionErrors.data_retention_days}</p>
							)}
						</div>
						<div>
							<label className="text-xs text-muted-foreground">Score & insight retention (days)</label>
							<Input
								type="number"
								min={7}
								value={scoreRetentionDays}
								onChange={(e) => setScoreRetentionDays(e.target.value)}
								placeholder="e.g. 30 (default: 2x trace retention)"
								className="mt-1 h-8 max-w-50 text-sm"
							/>
							{retentionErrors.score_retention_days && (
								<p className="mt-1 text-xs text-destructive">{retentionErrors.score_retention_days}</p>
							)}
						</div>
						<div>
							<label className="text-xs text-muted-foreground">Max trace count (optional)</label>
							<Input
								type="number"
								min={1000}
								value={maxTraceCount}
								onChange={(e) => setMaxTraceCount(e.target.value)}
								placeholder="e.g. 100000"
								className="mt-1 h-8 max-w-50 text-sm"
							/>
							{retentionErrors.max_trace_count && (
								<p className="mt-1 text-xs text-destructive">{retentionErrors.max_trace_count}</p>
							)}
						</div>
						{retentionErrors.general && <p className="text-xs text-destructive">{retentionErrors.general}</p>}
					</div>
				)}

				<div className="flex justify-end px-4 py-3">
					<Button size="sm" className="h-8" onClick={handleSave} disabled={retentionLoading || retentionSaving || hasErrors}>
						{retentionSaving ? (
							<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
						) : (
							<Save className="mr-1.5 h-3.5 w-3.5" />
						)}
						Save
					</Button>
				</div>
			</SettingsCard>

			<Dialog
				open={showConfirm}
				onOpenChange={(open) => {
					if (!open) {
						setShowConfirm(false);
						setPreview(null);
					}
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-sm">
							<AlertTriangle className="h-4 w-4 text-warning" />
							Enable data retention?
						</DialogTitle>
						<DialogDescription className="text-xs">
							This will permanently delete telemetry data older than {retentionDays} days. Purges run
							automatically every 6 hours. This action cannot be undone.
						</DialogDescription>
					</DialogHeader>
					{preview && (
						<div className="space-y-1 rounded bg-muted/50 p-3 text-xs">
							<p className="font-medium text-muted-foreground">Estimated deletions:</p>
							{Object.entries(preview)
								.filter(([k]) => !k.startsWith("_"))
								.map(([k, v]) => (
									<p key={k}>
										{k}: {typeof v === "number" ? v.toLocaleString() : v} rows
									</p>
								))}
						</div>
					)}
					<label className="flex cursor-pointer items-center gap-2 text-xs">
						<Checkbox checked={confirmChecked} onCheckedChange={(checked) => setConfirmChecked(checked === true)} />
						I understand this will permanently delete data
					</label>
					<DialogFooter>
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setShowConfirm(false);
								setPreview(null);
							}}
						>
							Cancel
						</Button>
						<Button size="sm" variant="destructive" onClick={handleConfirm} disabled={!confirmChecked}>
							Enable retention
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SettingsSection>
	);
}

function MigrationSection() {
	const { openHelp } = useHelp();
	const [migrateOpen, setMigrateOpen] = useState(false);

	return (
		<SettingsSection
			id="migration"
			title="Data migration"
			description="Move registry data and telemetry between Caracal instances."
			actions={<SectionHelpButton sectionTitle="Data Migration" />}
		>
			<SettingsCard>
				<SettingRow
					label="Export, import, and validate instance data"
					description="Start with the guide if this is your first run."
				>
					<Button type="button" variant="outline" size="sm" onClick={() => openHelp({ pageKey: "migration" })}>
						<HelpCircle className="h-3.5 w-3.5" />
						Guide
					</Button>
					<Button type="button" size="sm" onClick={() => setMigrateOpen(true)}>
						<ArrowLeftRight className="h-3.5 w-3.5" />
						Migrate
					</Button>
				</SettingRow>
			</SettingsCard>
			<MigrateDialog open={migrateOpen} onOpenChange={setMigrateOpen} />
		</SettingsSection>
	);
}

function PurgeSection() {
	const queryClient = useQueryClient();
	const [purging, setPurging] = useState(false);

	const handlePurge = useCallback(async () => {
		if (
			!window.confirm(
				"Permanently delete all traces/session telemetry and insight reports for this deployment? This cannot be undone.",
			)
		) {
			return;
		}
		setPurging(true);
		try {
			const res = await admin.purgeTracesAndInsights();
			queryClient.invalidateQueries();
			toast.success(`Purged telemetry and insights (${res.deleted_reports ?? 0} reports removed)`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to purge traces and insights");
		} finally {
			setPurging(false);
		}
	}, [queryClient]);

	return (
		<SettingsSection
			id="danger"
			title="Danger zone"
			danger
			description="Destructive maintenance actions. Use only when you intentionally want to purge stored data."
			actions={<SectionHelpButton sectionTitle="Telemetry Purge" />}
		>
			<div className="rounded-md border border-destructive/40 bg-destructive/5">
				<SettingRow
					label={<span className="text-destructive">Purge traces & insights</span>}
					description="Deletes all session telemetry and insight reports for this deployment. Registry data is untouched."
				>
					<Button variant="destructive" size="sm" className="h-8" onClick={handlePurge} disabled={purging}>
						{purging ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
						Purge
					</Button>
				</SettingRow>
			</div>
		</SettingsSection>
	);
}

export default function TelemetrySettingsPage() {
	const { ready } = useRoleGuard("operator");
	if (!ready) return null;

	return (
		<div className="mx-auto w-full max-w-6xl p-6">
			<SettingsPage
				title="Telemetry & Data"
				description="Deployment-wide telemetry policy and data lifecycle."
				scope="instance"
			>
				<TracingPolicySection />
				<RetentionSection />
				<MigrationSection />
				<PurgeSection />
			</SettingsPage>
		</div>
	);
}
