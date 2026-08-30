// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// The owner's lifecycle controls for an in-flight component submission
// (draft, pending, or rejected), rendered on the resource's own page so a
// submission is authored, submitted, and tracked in one place. Editing reuses
// SubmitComponentDialog - the same form that created the draft; pending
// submissions take an edit lock first.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileEdit, Send } from "lucide-react";
import { toast } from "sonner";
import { SubmitComponentDialog } from "@/components/registry/submit-component-dialog";
import { Button } from "@/components/ui/button";
import { useCancelEdit, useComponentSubmitDraft, useComponentUpdateDraft } from "@/hooks/use-api";
import { getAccessToken, registry, type RegistryType } from "@/lib/api";
import type { RegistryItem } from "@/lib/types";

const IN_FLIGHT = new Set(["draft", "pending", "rejected"]);

export function OwnerSubmissionActions({
	type,
	item,
	onChanged,
}: {
	type: RegistryType;
	item: RegistryItem;
	/** Refresh the resource after the submission advances. */
	onChanged: () => void;
}) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const qc = useQueryClient();
	const submitDraft = useComponentSubmitDraft(type);
	const updateDraft = useComponentUpdateDraft(type);
	const cancelEdit = useCancelEdit(type);
	const status = item.status ?? "";

	function refreshLifecycle() {
		qc.invalidateQueries({ queryKey: ["component-versions", type, item.id] });
		qc.invalidateQueries({ queryKey: ["review"] });
		onChanged();
	}

	// Release the pending edit lock if the tab closes mid-edit.
	const lockedRef = useRef(false);
	lockedRef.current = dialogOpen && status === "pending";
	useEffect(() => {
		const release = () => {
			if (!lockedRef.current) return;
			const token = getAccessToken();
			fetch(`/api/v1/${type}/${item.id}/cancel-edit`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				keepalive: true,
			});
		};
		window.addEventListener("beforeunload", release);
		return () => window.removeEventListener("beforeunload", release);
	}, [type, item.id]);

	if (!IN_FLIGHT.has(status)) return null;

	async function openEdit() {
		setBusy(true);
		try {
			// Pending submissions take an edit lock before the form opens.
			if (status === "pending") await registry.startEdit(item.id, type);
			setDialogOpen(true);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to start editing");
		} finally {
			setBusy(false);
		}
	}

	async function submitForReview() {
		setBusy(true);
		try {
			await submitDraft.mutateAsync(item.id);
			refreshLifecycle();
		} catch {
			// useComponentSubmitDraft already surfaces the error toast.
		} finally {
			setBusy(false);
		}
	}

	function closeAnd(afterSuccess = true) {
		setDialogOpen(false);
		if (afterSuccess) refreshLifecycle();
	}

	return (
		<>
			<Button
				variant="outline"
				size="sm"
				className="h-7 gap-1.5 text-xs"
				disabled={busy}
				onClick={() => void openEdit()}
			>
				<FileEdit className="h-3.5 w-3.5" />
				{status === "pending" ? "Edit submission" : "Edit draft"}
			</Button>
			{(status === "draft" || status === "rejected") && (
				<Button size="sm" className="h-7 gap-1.5 text-xs" disabled={busy} onClick={() => void submitForReview()}>
					<Send className="h-3.5 w-3.5" />
					{status === "rejected" ? "Resubmit for review" : "Submit for review"}
				</Button>
			)}
			<SubmitComponentDialog
				key={`${item.id}-${dialogOpen}`}
				open={dialogOpen}
				onOpenChange={(open) => {
					if (!open && status === "pending") cancelEdit.mutate(item.id);
					setDialogOpen(open);
				}}
				type={type}
				editItem={item as unknown as Record<string, unknown>}
				onSubmit={(body) => {
					if (status === "pending") {
						updateDraft.mutate({ id: item.id, body }, { onSuccess: () => closeAnd() });
					} else {
						submitDraft.mutate(item.id, { onSuccess: () => closeAnd() });
					}
				}}
				onSaveDraft={(body) => updateDraft.mutate({ id: item.id, body }, { onSuccess: () => closeAnd() })}
				onUpdateDraft={(id, body) => updateDraft.mutate({ id, body }, { onSuccess: () => closeAnd() })}
				isSubmitting={submitDraft.isPending}
				isSavingDraft={updateDraft.isPending}
			/>
		</>
	);
}
