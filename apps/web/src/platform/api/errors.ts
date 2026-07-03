/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file classifies Console API errors into the user-facing messages shared across console routes.
*/
import { ConsoleApiError } from "./client";

// Resolves a thrown value to a user-facing message. Routes may pass code-specific overrides for
// their own domain errors; the shared control-plane classification applies to everything else.
export function errorMessage(error: unknown, overrides?: Record<string, string>): string {
  if (error instanceof ConsoleApiError) {
    const override = overrides?.[error.code];
    if (override) return override;
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    return error.code.replace(/_/g, " ");
  }
  return "Unexpected error.";
}

// Coordinator routes reach the agent coordinator rather than the control plane, so they classify
// its distinct not-configured and unreachable codes separately from the shared helper.
export function coordinatorErrorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.code === "coordinator_not_configured") return "Coordinator service not connected.";
    if (error.code === "upstream_unreachable") return "Coordinator service unreachable.";
    return error.code.replace(/_/g, " ");
  }
  return "Unexpected error.";
}
