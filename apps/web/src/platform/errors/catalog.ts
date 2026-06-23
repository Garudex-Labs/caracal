/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file is the single source of truth for full-page error content across the web client.
*/
export type ErrorAction = "retry" | "signin" | "dashboard" | "home";

export interface ErrorEntry {
  title: string;
  description: string;
  actions: ErrorAction[];
}

export const ERROR_CATALOG: Record<number, ErrorEntry> = {
  400: {
    title: "Bad request",
    description:
      "The request was malformed or missing required information. Check the link and try again.",
    actions: ["home"],
  },
  401: {
    title: "Sign in required",
    description: "You need to sign in to access this page. Your session may have expired.",
    actions: ["signin", "home"],
  },
  403: {
    title: "Access denied",
    description:
      "You are signed in, but your authority does not include the scope required for this action. Ask an administrator to grant the necessary permission.",
    actions: ["dashboard", "home"],
  },
  404: {
    title: "Page not found",
    description: "The page, resource, or route you're looking for doesn't exist or has been moved.",
    actions: ["home"],
  },
  405: {
    title: "Method not allowed",
    description:
      "This action isn't permitted on this resource. Return home and try a supported action.",
    actions: ["home"],
  },
  408: {
    title: "Request timed out",
    description: "The request took too long to complete. Check your connection and try again.",
    actions: ["retry", "home"],
  },
  409: {
    title: "Conflict",
    description:
      "This change conflicts with the current state, such as a duplicate name or a concurrent update. Reload and try again.",
    actions: ["retry", "home"],
  },
  422: {
    title: "Validation error",
    description: "The submitted data didn't pass validation. Review the values and try again.",
    actions: ["home"],
  },
  429: {
    title: "Too many requests",
    description: "You have sent too many requests in a short period. Wait a moment and try again.",
    actions: ["retry", "home"],
  },
  500: {
    title: "Something went wrong",
    description: "An unexpected error occurred on our end. You can try again or head back home.",
    actions: ["retry", "home"],
  },
  502: {
    title: "Bad gateway",
    description: "An upstream service returned an invalid response. Please try again shortly.",
    actions: ["retry", "home"],
  },
  503: {
    title: "Service unavailable",
    description:
      "Caracal is temporarily unavailable, either for maintenance or because a control-plane service is unreachable. Please try again shortly.",
    actions: ["retry", "home"],
  },
  504: {
    title: "Gateway timeout",
    description: "An upstream dependency took too long to respond. Please try again shortly.",
    actions: ["retry", "home"],
  },
};

export const FALLBACK_ERROR_CODE = 500;

export function errorEntry(code: number): ErrorEntry {
  return ERROR_CATALOG[code] ?? ERROR_CATALOG[FALLBACK_ERROR_CODE];
}
