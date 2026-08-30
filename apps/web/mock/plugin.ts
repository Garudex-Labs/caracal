// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Dev-only mock API: a Vite middleware that answers /api/v1/* from static
// fixtures so the frontend can be developed without a running backend.
// Enabled by `pnpm dev:mock` (VITE_MOCK_API=1). App code is untouched - every
// component keeps calling the same endpoints it will use against the real
// server, so switching back is just running plain `pnpm dev`.

import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createRoutes, dispatch, type MockOptions } from "./handlers";
import { MOCK_USER, mockJwt } from "./data";

const API_PREFIX = "/api/v1";

// The mock has no real sessions. This flag lets it honor sign-out so the auth
// flow (sign-out → login form) matches production instead of re-authenticating.
let mockSignedOut = false;

function readJson(path: string): unknown | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolveBody) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			if (chunks.length === 0) return resolveBody(undefined);
			try {
				resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
			} catch {
				resolveBody(undefined);
			}
		});
		req.on("error", () => resolveBody(undefined));
	});
}

function send(res: ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	// Every mock response is marked so fabricated state is always identifiable.
	res.setHeader("X-Caracal-Mock", "1");
	if (status === 204 || body === undefined) {
		res.end();
		return;
	}
	if (typeof body === "string") {
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end(body);
		return;
	}
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}

function authContextFromBearer(req: IncomingMessage): "tenant" | "operator" {
	const header = req.headers.authorization ?? "";
	const token = Array.isArray(header) ? header[0] : header;
	const payload = token?.startsWith("Bearer ") ? token.slice("Bearer ".length).split(".")[1] : "";
	if (!payload) return "tenant";
	try {
		const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
		return parsed.auth_context === "operator" ? "operator" : "tenant";
	} catch {
		return "tenant";
	}
}

export function mockApiPlugin(rootDir: string): Plugin {
	const pkg = readJson(resolve(rootDir, "package.json")) as { version?: string } | null;
	const options: MockOptions = {
		harnessRegistry: readJson(
			resolve(rootDir, "../packages/harness-data/registry.json"),
		) as MockOptions["harnessRegistry"],
		appVersion: pkg?.version ?? "0.0.0-mock",
	};
	const routes = createRoutes(options);
	const delayMs = Number(process.env.MOCK_API_DELAY ?? "120");

	return {
		name: "caracal-mock-api",
		apply: "serve",
		// On-page marker: fixture data must never be mistaken for real product
		// state. This hook only exists while the mock plugin is active.
		transformIndexHtml(html) {
			const badge =
				'<div style="position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:99999;' +
				'background:#7f1d1d;color:#fecaca;font:600 11px/1 monospace;padding:4px 10px;' +
				'border:1px solid #b91c1c;border-radius:4px;pointer-events:none">MOCK DATA \u2014 dev test harness, not real state</div>';
			return html.replace("</body>", `${badge}</body>`);
		},
		configureServer(server) {
			server.config.logger.info(
				`[mock-api] serving /api/v1/* from web/mock fixtures (${routes.length} routes, ${delayMs}ms delay)`,
			);
			server.middlewares.use((req, res, next) => {
				const url = new URL(req.url ?? "/", "http://localhost");
				if (url.pathname === "/health") {
					return send(res, 200, { status: "ok", mock: true });
				}

				// Better Auth identity-service surface: enough of /api/auth/*
				// for the app shell (any sign-in method establishes the mock
				// admin session).
				if (url.pathname.startsWith("/api/auth/")) {
					const authPath = url.pathname.slice("/api/auth".length);
					if (authPath === "/token") {
						return send(res, 410, { error: "use a context-specific token endpoint" });
					}
					if (authPath === "/tenant-token" || authPath === "/operator-token") {
						if (mockSignedOut) return send(res, 401, { error: "no session" });
						const context = authPath === "/operator-token" ? "operator" : "tenant";
						if (context === "operator" && MOCK_USER.role !== "operator") {
							return send(res, 403, { error: "not authorized for this authentication context" });
						}
						return send(res, 200, { token: mockJwt(context), auth_context: context });
					}
					if (authPath === "/public-config") {
						return send(res, 200, {
							email_password: true,
							google: false,
							github: false,
							sso: false,
							passkeys: false,
							magic_links: false,
							dev_login: true,
						});
					}
					if (authPath === "/get-session") {
						if (mockSignedOut) return send(res, 200, null);
						return send(res, 200, { session: { id: "mock-session" }, user: { id: "mock" } });
					}
					if (authPath === "/sign-in/email" || authPath === "/dev/login") {
						mockSignedOut = false;
						return send(res, 200, { redirect: false, token: "mock-session-token" });
					}
					if (authPath === "/sign-out") {
						mockSignedOut = true;
						return send(res, 200, { success: true });
					}
					server.config.logger.warn(`[mock-api] 404 ${req.method} /api/auth${authPath}`);
					return send(res, 404, { error: `Mock has no handler for /api/auth${authPath}` });
				}

				if (!url.pathname.startsWith(`${API_PREFIX}/`)) return next();

				const method = (req.method ?? "GET").toUpperCase();
				const path = url.pathname.slice(API_PREFIX.length);
				if (method === "GET" && path === "/auth/whoami") {
					const context = authContextFromBearer(req);
					const role = context === "operator" ? "operator" : MOCK_USER.role === "reviewer" ? "reviewer" : "user";
					return send(res, 200, { ...MOCK_USER, role, auth_context: context });
				}

				// Binary asset endpoint: point the favicon at the bundled logo.
				if (method === "GET" && path === "/config/favicon") {
					res.statusCode = 302;
					res.setHeader("Location", "/caracal_sq.png");
					res.end();
					return;
				}

				void readBody(req).then((body) => {
					const result = dispatch(routes, method, path, url.searchParams, body);
					const respond = () => {
						if (result) {
							send(res, result.status, result.body);
						} else {
							server.config.logger.warn(
								`[mock-api] 404 ${method} ${API_PREFIX}${path} - add a route in web/mock/handlers.ts`,
							);
							send(res, 404, {
								detail: `Mock API has no handler for ${method} ${API_PREFIX}${path}. Add one in web/mock/handlers.ts.`,
							});
						}
					};
					if (delayMs > 0) setTimeout(respond, delayMs);
					else respond();
				});
			});
		},
	};
}
