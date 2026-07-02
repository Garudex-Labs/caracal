/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the password reset completion route reached from the emailed reset link.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button, PasswordField } from "@/components/ui";
import { resetPassword } from "@/platform/auth";
import { content } from "@/platform/content/resolver";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const t = content.auth;
  const { token, error: linkError } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const { error: resetError } = await resetPassword({ newPassword: password, token });
    setBusy(false);
    if (resetError) {
      setError(resetError.message ?? "Could not update the password.");
      return;
    }
    setDone(true);
  }

  return (
    <AuthLayout
      title={t.resetPasswordTitle}
      subtitle={t.resetPasswordSubtitle}
      footer={
        <Link to="/sign-in" className="hover:text-foreground">
          {t.toSignIn}
        </Link>
      }
    >
      {done ? (
        <p className="text-sm text-muted-foreground">{t.resetPasswordDone}</p>
      ) : !token || linkError ? (
        <p className="text-sm text-muted-foreground">
          {t.resetLinkInvalid}{" "}
          <Link to="/reset" className="font-medium text-foreground hover:underline">
            {t.resetTitle}
          </Link>
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <PasswordField
            label={t.newPasswordLabel}
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Updating…" : t.resetPasswordCta}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
