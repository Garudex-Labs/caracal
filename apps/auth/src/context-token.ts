// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type { Auth } from "./auth.js";

export const AUTH_CONTEXTS = ["tenant", "operator"] as const;
export type AuthContext = (typeof AUTH_CONTEXTS)[number];

type SessionUser = {
	id: string;
	email?: string | null;
	name?: string | null;
	role?: string | null;
};

export function isAuthContext(value: string): value is AuthContext {
	return (AUTH_CONTEXTS as readonly string[]).includes(value);
}

export function roleForContext(role: string | null | undefined, context: AuthContext): string | null {
	if (context === "operator") return role === "operator" ? "operator" : null;
	if (role === "operator") return "user";
	return role === "reviewer" ? "reviewer" : "user";
}

function effectiveRole(user: SessionUser, operatorEmails: readonly string[]): string | null | undefined {
	const email = user.email?.toLowerCase();
	return email && operatorEmails.includes(email) ? "operator" : user.role;
}

export function contextTokenPayload(
	user: SessionUser,
	context: AuthContext,
	operatorEmails: readonly string[] = [],
): Record<string, unknown> | null {
	const role = roleForContext(effectiveRole(user, operatorEmails), context);
	if (!role) return null;
	return {
		sub: user.id,
		email: user.email ?? "",
		role,
		name: user.name ?? "",
		auth_context: context,
	};
}

export async function mintContextToken(
	auth: Auth,
	request: Request,
	context: AuthContext,
	operatorEmails: readonly string[] = [],
): Promise<Response> {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "not authenticated" }, { status: 401 });
	}
	const payload = contextTokenPayload(session.user, context, operatorEmails);
	if (!payload) {
		return Response.json({ error: "not authorized for this authentication context" }, { status: 403 });
	}
	const token = await auth.api.signJWT({ body: { payload } });
	return Response.json({ token: token.token, auth_context: context });
}
