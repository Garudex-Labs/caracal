/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the shared branded full-page error screen used across all error states.
*/
import { Link } from "@tanstack/react-router";

import { errorEntry, type ErrorAction } from "@/platform/errors/catalog";

function ActionButtons({ actions, onRetry }: { actions: ErrorAction[]; onRetry?: () => void }) {
  const primary =
    "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90";
  const secondary =
    "inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent";

  return (
    <>
      {actions.map((action, index) => {
        const styles = index === 0 ? primary : secondary;
        if (action === "retry") {
          return (
            <button
              key={action}
              onClick={() => (onRetry ? onRetry() : window.location.reload())}
              className={styles}
            >
              Try again
            </button>
          );
        }
        if (action === "signin") {
          return (
            <Link key={action} to="/sign-in" className={styles}>
              Sign in
            </Link>
          );
        }
        if (action === "dashboard") {
          return (
            <Link key={action} to="/app" className={styles}>
              Back to dashboard
            </Link>
          );
        }
        return (
          <Link key={action} to="/" className={styles}>
            Go home
          </Link>
        );
      })}
    </>
  );
}

export function ErrorState({ code, onRetry }: { code: number; onRetry?: () => void }) {
  const entry = errorEntry(code);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
      <Link to="/" className="mb-10 flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-sm bg-foreground text-sm font-bold text-background">
          C
        </div>
        <span className="font-mono text-base font-semibold tracking-tight text-foreground">
          Caracal
        </span>
      </Link>

      <p className="font-mono text-7xl font-bold tracking-tight text-foreground">{code}</p>
      <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">{entry.title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{entry.description}</p>

      <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
        <ActionButtons actions={entry.actions} onRetry={onRetry} />
      </div>

      <div className="mt-10 flex items-center gap-4 text-xs text-muted-foreground">
        <a
          href="https://docs.caracal.run"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground"
        >
          Documentation
        </a>
        <span className="h-3 w-px bg-border" />
        <a
          href="https://github.com/Garudex-Labs/caracal/issues"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground"
        >
          Report an issue
        </a>
      </div>
    </div>
  );
}
