// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// User-facing error copy. Server 4xx details are curated and safe to show;
// transport failures and 5xx get fixed copy so internals never leak into the UI.

import { ApiError, type ApiErrorKind } from "./api";

const KIND_MESSAGES: Record<ApiErrorKind, string> = {
	network: "Can't reach the server. Check your connection and try again.",
	timeout: "The request timed out. Try again.",
	auth: "Your session has expired. Sign in again to continue.",
	permission: "You don't have permission to do that.",
	not_found: "That item doesn't exist or you don't have access to it.",
	conflict: "That change conflicts with the current state. Reload and try again.",
	validation: "Some fields are invalid. Check the form and try again.",
	rate_limited: "Too many requests. Wait a moment and try again.",
	unavailable: "The service is temporarily unavailable. Try again shortly.",
	server: "Something went wrong on our side. Try again, or contact an administrator if it persists.",
	client: "The request couldn't be completed.",
};

/** A safe, actionable message for *error*, preferring curated server detail for 4xx. */
export function userMessageFor(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status >= 400 && error.status < 500 && error.status !== 401 && error.message) {
			return error.message;
		}
		return KIND_MESSAGES[error.kind];
	}
	if (error instanceof Error && error.message && !/failed to fetch/i.test(error.message)) {
		return error.message;
	}
	return "Something went wrong.";
}
