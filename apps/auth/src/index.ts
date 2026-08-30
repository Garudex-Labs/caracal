// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP entrypoint for the identity service.
 *
 * Better Auth handles every route under its base path. The only additions
 * are a health check, a public capability descriptor for the login UI, the
 * development-only dummy login, and the internal bridge (which the load
 * balancer never routes).
 */

import { createServer } from "node:http";
import { toNodeHandler } from "better-auth/node";
import { auth, pool } from "./auth.js";
import { getCapabilities } from "./capabilities.js";
import { isAuthContext, mintContextToken } from "./context-token.js";
import { handleDeviceApi } from "./device-sessions.js";
import { handleDevLogin } from "./dev-login.js";
import { env } from "./env.js";
import { handleInternal } from "./internal.js";

const deviceApiConfig = {
  basePath: env.basePath,
  retentionMs: env.sessionHistoryRetentionDays * 86_400_000,
};

const authHandler = toNodeHandler(auth);

async function publicConfig(): Promise<Response> {
  return Response.json(
    await getCapabilities(pool, {
      emailDelivery: !env.isProduction || Boolean(env.emailWebhookUrl),
      google: Boolean(env.google),
      github: Boolean(env.github),
      devLogin: env.devLoginEnabled,
    }),
  );
}

async function nodeRequestToFetchRequest(req: import("node:http").IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method: req.method, headers, body });
}

async function writeFetchResponse(res: import("node:http").ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
    } else {
      res.setHeader(key, value);
    }
  });
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  try {
    if (pathname === "/healthz") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (pathname === `${env.basePath}/public-config` && req.method === "GET") {
      await writeFetchResponse(res, await publicConfig());
      return;
    }

    if (pathname === `${env.basePath}/token`) {
      await writeFetchResponse(res, Response.json({ error: "use a context-specific token endpoint" }, { status: 410 }));
      return;
    }

    const contextTokenMatch = pathname.match(new RegExp(`^${env.basePath}/(tenant|operator)-token$`));
    if (contextTokenMatch) {
      if (req.method !== "GET") {
        await writeFetchResponse(res, Response.json({ error: "method not allowed" }, { status: 405 }));
        return;
      }
      const context = contextTokenMatch[1];
      if (!context || !isAuthContext(context)) {
        await writeFetchResponse(res, Response.json({ error: "not found" }, { status: 404 }));
        return;
      }
      const request = await nodeRequestToFetchRequest(req);
      await writeFetchResponse(res, await mintContextToken(auth, request, context, env.operatorEmails));
      return;
    }

    if (env.devLoginEnabled && pathname === `${env.basePath}/dev/login`) {
      const request = await nodeRequestToFetchRequest(req);
      await writeFetchResponse(res, await handleDevLogin(auth, request));
      return;
    }

    if (pathname.startsWith("/internal/")) {
      const request = await nodeRequestToFetchRequest(req);
      const response = await handleInternal(auth, pathname, request);
      await writeFetchResponse(res, response ?? Response.json({ error: "not found" }, { status: 404 }));
      return;
    }

    if (pathname.startsWith(`${env.basePath}/devices`) || pathname.startsWith(`${env.basePath}/device-sessions`)) {
      const request = await nodeRequestToFetchRequest(req);
      const response = await handleDeviceApi(auth, pathname, request, deviceApiConfig);
      if (response) {
        await writeFetchResponse(res, response);
        return;
      }
    }

    await authHandler(req, res);
  } catch (error) {
    console.error("[auth-service] unhandled error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
    }
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

server.listen(env.port, () => {
  console.info(
    `[auth-service] listening on :${env.port} (basePath=${env.basePath}, production=${env.isProduction}, devLogin=${env.devLoginEnabled})`,
  );
});
