/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file frames the authentication screens with the animated characters panel.
*/
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AnimatedCharacters } from "@/components/auth/AnimatedCharacters";

export function AuthSplitLayout({
  title,
  subtitle,
  characters,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  characters: { typing: boolean; passwordLength: number; revealed: boolean };
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside
        className="relative hidden flex-col justify-between overflow-hidden border-r border-border p-10 text-white lg:flex"
        style={{ backgroundColor: "#121016" }}
      >
        <Link to="/" className="relative z-10 flex items-center">
          <img src="/caracal_dark.png" alt="Caracal" className="h-auto w-56 max-w-full" />
        </Link>

        <div className="relative z-10 flex items-end justify-center">
          <AnimatedCharacters
            typing={characters.typing}
            passwordLength={characters.passwordLength}
            revealed={characters.revealed}
          />
        </div>

        <div className="relative z-10 max-w-sm space-y-4">
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-white/55">
            <Link to="/legal" className="transition-colors hover:text-white">
              Privacy Policy
            </Link>
            <Link to="/legal" className="transition-colors hover:text-white">
              Terms of Service
            </Link>
            <Link to="/legal" className="transition-colors hover:text-white">
              Licensing
            </Link>
          </nav>
        </div>

        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 top-1/4 h-72 w-72 rounded-full opacity-25 blur-3xl"
          style={{ backgroundColor: "#6C3FF5" }}
        />
      </aside>

      <main className="flex items-center justify-center bg-background p-8">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center justify-center gap-2 lg:hidden">
            <div className="grid h-8 w-8 place-items-center rounded-sm bg-foreground text-sm font-bold text-background">
              C
            </div>
            <span className="font-mono text-base font-semibold tracking-tight">Caracal</span>
          </Link>

          <div className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
          </div>

          {children}

          {footer ? (
            <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
