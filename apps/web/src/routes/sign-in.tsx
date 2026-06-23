/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the sign-in route.
*/
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AuthLayout } from "@/components/auth/AuthLayout";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { Button, Field } from "@/components/ui";
import { signIn } from "@/platform/auth";
import { hasSession } from "@/platform/auth/guards";
import { content } from "@/platform/content/resolver";

export const Route = createFileRoute("/sign-in")({
  beforeLoad: async () => {
    if (await hasSession()) throw redirect({ to: "/app" });
  },
  component: SignInPage,
});

function SignInPage() {
  const navigate = useNavigate();
  const t = content.auth;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await signIn.email({ email, password });
    setBusy(false);
    if (signInError) {
      setError(signInError.message ?? "Could not sign in.");
      return;
    }
    navigate({ to: "/app" });
  }

  return (
    <AuthLayout
      title={t.signInTitle}
      subtitle={t.signInSubtitle}
      footer={
        <Link to="/sign-up" className="hover:text-foreground">
          {t.toSignUp}
        </Link>
      }
    >
      <div className="flex flex-col gap-5">
        <SocialButtons callbackURL={`${window.location.origin}/app`} />
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field
            label={t.emailLabel}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            label={t.passwordLabel}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : t.signInCta}
          </Button>
          <Link
            to="/reset"
            className="text-center text-xs text-muted-foreground hover:text-foreground"
          >
            {t.forgot}
          </Link>
        </form>
      </div>
    </AuthLayout>
  );
}
