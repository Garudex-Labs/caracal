// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { AlertCircle, LogIn, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiErrorKind, apiErrorStatus } from "@/lib/api";
import { userMessageFor } from "@/lib/errors";

interface ErrorStateProps {
  message?: string;
  /** The thrown error; when provided it drives classification and copy. */
  error?: unknown;
  onRetry?: () => void;
}

export function ErrorState({ message, error, onRetry }: ErrorStateProps) {
  const kind = apiErrorKind(error);
  const isSessionExpired =
    kind === "auth" ||
    apiErrorStatus(error) === 401 ||
    message === "Session expired" ||
    message?.toLowerCase() === "unauthorized" ||
    message?.toLowerCase() === "not authenticated";

  if (isSessionExpired) {
    return (
      <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-muted-foreground/30 py-16">
        <LogIn className="h-10 w-10 text-muted-foreground/60" />
        <p className="mt-4 text-sm font-medium">Your login has expired</p>
        <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
          Please sign in again to continue.
        </p>
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <a href="/login?reason=session_expired">
            <LogIn className="mr-1.5 h-3.5 w-3.5" /> Sign in
          </a>
        </Button>
      </div>
    );
  }

  const offline = kind === "network" || kind === "timeout";
  const shown =
    (error !== undefined ? userMessageFor(error) : message) ??
    "Failed to load data. Check your connection and try again.";

  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-destructive/30 py-16">
      {offline ? (
        <WifiOff className="h-10 w-10 text-destructive/60" />
      ) : (
        <AlertCircle className="h-10 w-10 text-destructive/60" />
      )}
      <p className="mt-4 text-sm font-medium">
        {offline ? "Connection problem" : "Something went wrong"}
      </p>
      <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">{shown}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      )}
    </div>
  );
}
