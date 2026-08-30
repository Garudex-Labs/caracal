// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Strong confirmation for destructive organization operations: states the
// impact explicitly and, for irreversible actions, requires typing the
// resource identifier before the destructive button arms.

import { useState, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ConfirmActionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	/** Bullet list of concrete consequences shown before confirming. */
	impact?: ReactNode[];
	/** When set, the destructive button stays disabled until this is typed. */
	confirmationText?: string;
	confirmLabel: string;
	pending?: boolean;
	onConfirm: () => void;
}

export function ConfirmActionDialog({
	open,
	onOpenChange,
	title,
	description,
	impact,
	confirmationText,
	confirmLabel,
	pending,
	onConfirm,
}: ConfirmActionDialogProps) {
	const [typed, setTyped] = useState("");
	const armed = !confirmationText || typed === confirmationText;

	function close(next: boolean) {
		if (!next) setTyped("");
		onOpenChange(next);
	}

	return (
		<AlertDialog open={open} onOpenChange={close}>
			<AlertDialogContent className="sm:max-w-md">
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<TriangleAlert className="h-4 w-4 text-destructive" />
						{title}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-3 text-left">
							<div className="text-sm text-muted-foreground">{description}</div>
							{impact && impact.length > 0 && (
								<ul className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
									{impact.map((item, index) => (
										<li key={index} className="flex gap-2 text-xs text-muted-foreground">
											<span aria-hidden className="text-destructive">
												•
											</span>
											<span className="min-w-0">{item}</span>
										</li>
									))}
								</ul>
							)}
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				{confirmationText && (
					<div>
						<p className="text-xs text-muted-foreground">
							Type <span className="font-mono font-medium text-foreground">{confirmationText}</span> to confirm.
						</p>
						<Input
							value={typed}
							onChange={(e) => setTyped(e.target.value)}
							aria-label="Confirmation text"
							autoComplete="off"
							spellCheck={false}
							className={cn("mt-1.5 h-8 font-mono text-sm")}
						/>
					</div>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
					<Button
						variant="destructive"
						size="sm"
						disabled={!armed || pending}
						onClick={() => onConfirm()}
					>
						{pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
						{confirmLabel}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
