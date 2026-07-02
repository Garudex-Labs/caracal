/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the password reset request route.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button, Field } from "@/components/ui";
import { fetchEnabledProviders, requestPasswordReset } from "@/platform/auth";
import { content } from "@/platform/content/resolver";

export const Route = createFileRoute("/reset")({
  component: ResetPage,
});

function ResetPage() {
  const t = content.auth;
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    fetchEnabledProviders().then((enabled) => {
      if (active) setAvailable(enabled.passwordReset);
    });
    return () => {
      active = false;
    };
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: resetError } = await requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (resetError) {
      setError(resetError.message ?? "Could not send the reset email.");
      return;
    }
    setSent(true);
  }

  return (
    <AuthLayout
      title={t.resetTitle}
      subtitle={t.resetSubtitle}
      footer={
        <Link to="/sign-in" className="hover:text-foreground">
          {t.toSignIn}
        </Link>
      }
    >
      {available === false ? (
        <p className="text-sm text-muted-foreground">{t.resetUnavailable}</p>
      ) : sent ? (
        <p className="text-sm text-muted-foreground">
          If an account exists for {email}, a reset link is on its way.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field
            label={t.emailLabel}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={busy || available === null}>
            {busy ? "Sending…" : t.resetCta}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
