// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Restart-required indicator shared by the instance settings pages. Some
// server settings only take effect after an API restart; the chip reflects
// the pending state and offers the restart action.

import { Loader2, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRestartApi, useRestartStatus } from "@/hooks/use-api";

export function RestartStatusControl({ onRestarted }: { onRestarted?: () => void }) {
	const { data: restartStatus, refetch } = useRestartStatus();
	const { restarting, restartApi } = useRestartApi(() => {
		refetch();
		onRestarted?.();
	});

	return (
		<div className="flex items-center gap-2">
			<span
				className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
					restartStatus?.required
						? "border-warning/30 bg-warning/10 text-warning"
						: "border-success/30 bg-success/10 text-success"
				}`}
			>
				{restartStatus?.required ? "Saved, API restart required" : "Settings live"}
			</span>
			{restartStatus?.required && (
				<Button size="sm" variant="outline" onClick={restartApi} disabled={restarting}>
					{restarting ? (
						<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
					) : (
						<Power className="mr-1.5 h-3.5 w-3.5" />
					)}
					{restarting ? "Restarting" : "Restart API"}
				</Button>
			)}
		</div>
	);
}
