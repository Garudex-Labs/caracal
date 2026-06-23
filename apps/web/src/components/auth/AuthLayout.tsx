/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file frames the authentication screens.
*/
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-sm bg-foreground text-sm font-bold text-background">
            C
          </div>
          <span className="font-mono text-base font-semibold tracking-tight">Caracal</span>
        </Link>
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        {footer ? (
          <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
