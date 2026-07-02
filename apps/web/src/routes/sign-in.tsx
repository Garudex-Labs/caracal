/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the sign-in route.
*/
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { Button, Field, PasswordField } from "@/components/ui";
import { fetchEnabledProviders, signIn } from "@/platform/auth";
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
  const [revealed, setRevealed] = useState(false);
  const [remember, setRemember] = useState(true);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetAvailable, setResetAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    fetchEnabledProviders().then((enabled) => {
      if (active) setResetAvailable(enabled.passwordReset);
    });
    return () => {
      active = false;
    };
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await signIn.email({ email, password, rememberMe: remember });
    setBusy(false);
    if (signInError) {
      setError(signInError.message ?? "Could not sign in.");
      return;
    }
    navigate({ to: "/app" });
  }

  return (
    <AuthSplitLayout
      title={t.signInTitle}
      subtitle={t.signInSubtitle}
      characters={{ typing, passwordLength: password.length, revealed }}
      footer={
        <Link to="/sign-up" className="font-medium text-foreground hover:underline">
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
            placeholder="you@company.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
          />
          <PasswordField
            label={t.passwordLabel}
            autoComplete="current-password"
            placeholder="••••••••"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onRevealChange={setRevealed}
          />

          <div className="flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-input accent-[var(--color-foreground)]"
              />
              Remember me
            </label>
            {resetAvailable ? (
              <Link to="/reset" className="text-sm text-muted-foreground hover:text-foreground">
                {t.forgot}
              </Link>
            ) : null}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <Button type="submit" loading={busy} className="w-full">
            {busy ? "Signing in…" : t.signInCta}
          </Button>
        </form>
      </div>
    </AuthSplitLayout>
  );
}
