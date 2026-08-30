// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Complete version history for a resource: every version with its status and
// attribution, pairwise compare between any two versions, and controlled
// rollback - restore derives a new pending change from an approved historical
// version instead of mutating history.

import { useState } from "react";
import { ArrowRight, GitCompareArrows, History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PickerSelect } from "@/components/ui/picker-select";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/registry/status-badge";
import { YamlDiffView } from "@/components/review/yaml-diff-view";
import { eventTime } from "./activity-panel";

export interface WorkspaceVersionRow {
	id: string;
	version: string;
	status: string;
	description?: string | null;
	changelog?: string | null;
	released_by?: string;
	released_at?: string | null;
	created_at?: string | null;
	rejection_reason?: string | null;
	is_prerelease?: boolean;
}

export function VersionsPanel({
	rows,
	isLoading,
	activeVersion,
	onOpenChange,
	canRestore,
	restoreBusy,
	onRestore,
	loadDiff,
}: {
	rows: WorkspaceVersionRow[];
	isLoading?: boolean;
	/** The currently active (latest approved) version. */
	activeVersion?: string | null;
	/** Open the in-context review surface for this resource's pending change. */
	onOpenChange?: () => void;
	canRestore?: boolean;
	restoreBusy?: boolean;
	onRestore?: (version: string, reason?: string) => void;
	/** Unified diff between two versions; empty string means identical. */
	loadDiff: (base: string, head: string) => Promise<string>;
}) {
	const [compareBase, setCompareBase] = useState<string | null>(null);
	const [compareHead, setCompareHead] = useState<string | null>(null);
	const [diff, setDiff] = useState<string | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffOpen, setDiffOpen] = useState(false);
	const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
	const [restoreReason, setRestoreReason] = useState("");

	const comparable = rows.filter((row) => row.status === "approved");
	const versionOptions = comparable.map((row) => ({
		value: row.version,
		label: `v${row.version}${row.version === activeVersion ? " (active)" : ""}`,
	}));

	async function runCompare() {
		if (!compareBase || !compareHead || compareBase === compareHead) return;
		setDiffLoading(true);
		setDiffOpen(true);
		try {
			setDiff(await loadDiff(compareBase, compareHead));
		} catch (err) {
			setDiffOpen(false);
			toast.error(err instanceof Error ? err.message : "Failed to compute diff");
		} finally {
			setDiffLoading(false);
		}
	}

	if (isLoading) {
		return <p className="py-4 text-xs text-muted-foreground">Loading versions…</p>;
	}
	if (rows.length === 0) {
		return (
			<EmptyState
				icon={History}
				title="No versions yet"
				description="Propose a change to release the first version of this resource."
			/>
		);
	}

	return (
		<div className="space-y-4">
			{comparable.length >= 2 && (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
					<GitCompareArrows className="h-3.5 w-3.5 text-muted-foreground" />
					<span className="text-xs text-muted-foreground">Compare</span>
					<PickerSelect
						value={compareBase ?? ""}
						onValueChange={setCompareBase}
						options={versionOptions}
						placeholder="Base"
						ariaLabel="Compare base version"
						className="w-36"
						inputClassName="h-7 px-2 text-xs"
					/>
					<ArrowRight className="h-3 w-3 text-muted-foreground" />
					<PickerSelect
						value={compareHead ?? ""}
						onValueChange={setCompareHead}
						options={versionOptions}
						placeholder="Head"
						ariaLabel="Compare head version"
						className="w-36"
						inputClassName="h-7 px-2 text-xs"
					/>
					<Button
						size="sm"
						variant="outline"
						className="h-7 px-2 text-xs"
						disabled={!compareBase || !compareHead || compareBase === compareHead}
						onClick={runCompare}
					>
						Compare
					</Button>
				</div>
			)}

			<div className="overflow-x-auto rounded-md border border-border">
				<table className="w-full border-collapse text-sm">
					<thead>
						<tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
							<th className="px-3 py-2 font-medium">Version</th>
							<th className="px-3 py-2 font-medium">Status</th>
							<th className="px-3 py-2 font-medium">Summary</th>
							<th className="px-3 py-2 text-right font-medium">Released</th>
							<th className="px-3 py-2 text-right font-medium">Actions</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							const isActive = row.version === activeVersion;
							return (
								<tr key={row.id} className="border-b border-border/60 last:border-b-0 hover:bg-muted/30">
									<td className="px-3 py-2 whitespace-nowrap">
										<span className="font-mono text-[13px] font-medium">v{row.version}</span>
										{isActive && (
											<Badge className="ml-2 bg-success/15 text-success border-transparent text-[10px]">
												active
											</Badge>
										)}
										{row.is_prerelease && (
											<Badge variant="outline" className="ml-2 text-[10px]">
												pre-release
											</Badge>
										)}
									</td>
									<td className="px-3 py-2">
										<StatusBadge status={row.status} />
									</td>
									<td className="max-w-md px-3 py-2">
										{row.description && (
											<p className="truncate text-xs text-muted-foreground">{row.description}</p>
										)}
										{row.changelog && (
											<p className="truncate text-[11px] text-muted-foreground/70 italic">{row.changelog}</p>
										)}
										{row.status === "rejected" && row.rejection_reason && (
											<p className="truncate text-[11px] text-destructive/90">{row.rejection_reason}</p>
										)}
									</td>
									<td className="px-3 py-2 text-right text-xs whitespace-nowrap text-muted-foreground">
										{eventTime(row.released_at ?? row.created_at)}
									</td>
									<td className="px-3 py-2 text-right whitespace-nowrap">
										<span className="inline-flex items-center gap-1">
											{row.status === "pending" && onOpenChange && (
												<Button
													size="sm"
													variant="ghost"
													className="h-6 px-2 text-[11px] text-primary"
													onClick={onOpenChange}
												>
													View change
												</Button>
											)}
											{canRestore && row.status === "approved" && !isActive && (
												<Button
													size="sm"
													variant="ghost"
													className="h-6 gap-1 px-2 text-[11px]"
													disabled={restoreBusy}
													onClick={() => {
														setRestoreReason("");
														setRestoreTarget(row.version);
													}}
												>
													<RotateCcw className="h-3 w-3" />
													Restore
												</Button>
											)}
										</span>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			<Dialog open={diffOpen} onOpenChange={setDiffOpen}>
				<DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
					<DialogHeader>
						<DialogTitle className="font-display text-sm">
							v{compareBase} <ArrowRight className="inline h-3 w-3" /> v{compareHead}
						</DialogTitle>
					</DialogHeader>
					<div className="min-h-64 flex-1 overflow-hidden rounded-md border border-border">
						{diffLoading ? (
							<div className="flex h-full items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
								<Loader2 className="h-4 w-4 animate-spin" />
								Computing diff…
							</div>
						) : diff ? (
							<YamlDiffView diff={diff} versionA={compareBase ?? ""} versionB={compareHead ?? ""} />
						) : (
							<div className="flex h-full items-center justify-center py-16 text-sm text-muted-foreground">
								These versions are identical.
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>

			<Dialog open={restoreTarget !== null} onOpenChange={(open) => !open && setRestoreTarget(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle className="font-display text-sm">Restore v{restoreTarget}?</DialogTitle>
					</DialogHeader>
					<div className="space-y-3 text-sm text-muted-foreground">
						<p>
							This proposes a new version derived from{" "}
							<span className="font-mono text-foreground">v{restoreTarget}</span>. Nothing is deleted or
							rewritten: the change enters the normal review workflow, and{" "}
							<span className="font-mono text-foreground">v{activeVersion ?? "–"}</span> stays active until
							the restore is approved and merged.
						</p>
						<Input
							value={restoreReason}
							onChange={(e) => setRestoreReason(e.target.value)}
							placeholder="Why is this restore needed? (optional, recorded in history)"
							className="h-8 text-xs"
						/>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setRestoreTarget(null)}>
							Cancel
						</Button>
						<Button
							disabled={restoreBusy}
							onClick={() => {
								if (restoreTarget) onRestore?.(restoreTarget, restoreReason.trim() || undefined);
								setRestoreTarget(null);
							}}
						>
							{restoreBusy ? (
								<>
									<Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
									Restoring…
								</>
							) : (
								"Propose restore"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
