// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Password reset landing page. Better Auth's reset email links here with
// ?token=...; the new password is submitted back through the auth client.

import { useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPasswordPage() {
	const { token, error: tokenError } = useSearch({ from: "/(auth)/reset-password" });
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [loading, setLoading] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState("");

	async function handleSubmit() {
		setError("");
		if (password.length < 12) {
			setError("Password must be at least 12 characters");
			return;
		}
		if (password !== confirm) {
			setError("Passwords do not match");
			return;
		}
		if (!token) {
			setError("This reset link is invalid or has expired.");
			return;
		}
		setLoading(true);
		const { error: resetError } = await authClient.resetPassword({
			newPassword: password,
			token,
		});
		setLoading(false);
		if (resetError) {
			setError(resetError.message || "Could not reset the password. The link may have expired.");
			return;
		}
		setDone(true);
		toast.success("Password updated. Sign in with your new password.");
	}

	return (
		<div className="flex min-h-dvh items-center justify-center bg-surface-sunken p-6">
			<div className="w-full max-w-md space-y-8">
				<div className="space-y-2 text-center">
					<h1 className="text-3xl font-semibold tracking-tight font-[family-name:var(--font-display)]">
						Reset your password
					</h1>
					<p className="text-sm text-muted-foreground">Choose a new password for your account</p>
				</div>

				{done ? (
					<div className="space-y-6 text-center">
						<CheckCircle2 className="mx-auto h-10 w-10 text-success" />
						<p className="text-sm text-muted-foreground">Your password has been updated.</p>
						<Button asChild className="w-full">
							<Link to="/login">Back to sign in</Link>
						</Button>
					</div>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							handleSubmit();
						}}
						className="space-y-6"
					>
						<div className="space-y-2">
							<Label htmlFor="new-password">New password</Label>
							<Input
								id="new-password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="At least 12 characters"
								required
								autoFocus
								className="h-12"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="confirm-password">Confirm password</Label>
							<Input
								id="confirm-password"
								type="password"
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								placeholder="Repeat the new password"
								required
								className="h-12"
							/>
						</div>

						{(error || tokenError) && (
							<div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
								<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
								<span>{error || "This reset link is invalid or has expired."}</span>
							</div>
						)}

						<Button type="submit" disabled={loading} className="h-12 w-full">
							{loading ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<>
									Reset password
									<ArrowRight className="ml-2 h-4 w-4" />
								</>
							)}
						</Button>
					</form>
				)}
			</div>
		</div>
	);
}
