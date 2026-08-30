// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Deployment AI-engine configuration: provider credentials, model routing,
// batch cadence, and concurrency limits for operator-managed report generation.

import { useState } from "react";
import { toast } from "sonner";
import { useRoleGuard } from "@/hooks/use-role-guard";
import { useAdminSettings } from "@/hooks/use-api";
import { admin } from "@/lib/api";
import type { AdminSetting } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { ErrorState } from "@/components/shared/error-state";
import { SettingsPage } from "@/components/settings/settings-shell";
import { InsightsSection } from "@/pages/settings/insights/insights-section";

export default function OperatorAiEnginePage() {
	const { ready } = useRoleGuard("operator", "operator");
	const { data: settings, isLoading, isError, error, refetch } = useAdminSettings();
	const [revokeConfirmKey, setRevokeConfirmKey] = useState<string | null>(null);

	if (!ready) return null;

	const entries: { key: string; value: string; is_sensitive?: boolean; is_set?: boolean }[] = Array.isArray(settings)
		? settings.map((s: AdminSetting) => ({
				key: s.key,
				value: s.value,
				is_sensitive: s.is_sensitive,
				is_set: s.is_set,
			}))
		: Object.entries(settings ?? {}).map(([key, value]) => ({ key, value: String(value) }));

	return (
		<div className="mx-auto w-full max-w-6xl p-6">
			<SettingsPage
				title="AI Engine"
				description="Deployment-level LLM backend, model routing, and batch policy for generated reports."
				scope="instance"
			>
			{isLoading ? (
				<TableSkeleton rows={5} cols={2} />
			) : isError ? (
				<ErrorState message={error?.message} onRetry={() => refetch()} />
			) : (
				<InsightsSection
					entries={entries}
					onSave={async (key, value) => {
						await admin.updateSetting(key, { value });
						refetch();
					}}
					onRevoke={(key) => setRevokeConfirmKey(key)}
					refetch={refetch}
				/>
			)}

			<Dialog open={revokeConfirmKey !== null} onOpenChange={(open) => { if (!open) setRevokeConfirmKey(null); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Revoke secret</DialogTitle>
						<DialogDescription>
							This permanently deletes the stored value for <strong>{revokeConfirmKey}</strong>.
							Generation jobs that depend on it will stop until a new value is configured.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setRevokeConfirmKey(null)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={async () => {
								try {
									await admin.revokeSetting(revokeConfirmKey!);
									refetch();
									toast.success(`Revoked ${revokeConfirmKey}`);
								} catch (err: unknown) {
									toast.error(err instanceof Error ? err.message : "Failed to revoke setting");
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
