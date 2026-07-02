/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the sign-up route.
*/
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { Button, Field, PasswordField } from "@/components/ui";
import { signUp } from "@/platform/auth";
import { hasSession } from "@/platform/auth/guards";
import { content } from "@/platform/content/resolver";

export const Route = createFileRoute("/sign-up")({
  beforeLoad: async () => {
    if (await hasSession()) throw redirect({ to: "/app" });
  },
  component: SignUpPage,
});

function SignUpPage() {
  const navigate = useNavigate();
  const t = content.auth;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifySent, setVerifySent] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: signUpError } = await signUp.email({ name, email, password });
    setBusy(false);
    if (signUpError) {
      setError(signUpError.message ?? "Could not create account.");
      return;
    }
    // When email verification is required, sign-up creates the account without a session; the
    // operator continues from the emailed verification link instead of the onboarding redirect.
    if (!data?.token) {
      setVerifySent(true);
      return;
    }
    navigate({ to: "/onboarding" });
  }

  return (
    <AuthSplitLayout
      title={t.signUpTitle}
      subtitle={t.signUpSubtitle}
      characters={{ typing, passwordLength: password.length, revealed }}
      footer={
        <Link to="/sign-in" className="font-medium text-foreground hover:underline">
          {t.toSignIn}
        </Link>
      }
    >
      {verifySent ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">{t.verifyEmailTitle}</p>
          <p className="text-sm text-muted-foreground">
            {t.verifyEmailNotice} {email}.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <SocialButtons callbackURL={`${window.location.origin}/app`} />
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field
              label={t.nameLabel}
              autoComplete="name"
              placeholder="Ada Lovelace"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
            />
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
              autoComplete="new-password"
              placeholder="••••••••"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onRevealChange={setRevealed}
            />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button type="submit" loading={busy} className="w-full">
              {busy ? "Creating account…" : t.signUpCta}
            </Button>
          </form>
        </div>
      )}
    </AuthSplitLayout>
  );
}
