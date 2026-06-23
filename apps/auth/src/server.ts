// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// HTTP entrypoint that exposes the Better Auth handler with CORS for the Community Edition web client.

import { createServer } from "node:http";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";

import { auth } from "./auth.ts";
import { handleAccount } from "./account.ts";
import { loadConfig } from "./config.ts";
import { handleConsole } from "./console.ts";
import { enabledProviders } from "./providers.ts";

const cfg = loadConfig();

async function ensureSchema(): Promise<void> {
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(auth.options);
  if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
}

function applyCors(origin: string, res: import("node:http").ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
}

await ensureSchema();

const handler = toNodeHandler(auth);

const server = createServer((req, res) => {
  applyCors(cfg.webOrigin, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if ((req.url ?? "").startsWith("/api/console")) {
    void handleConsole(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "console_proxy_failed" }));
      }
    });
    return;
  }

  if (req.url === "/account") {
    void handleAccount(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "account_lifecycle_failed" }));
      }
    });
    return;
  }

  if (req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", service: "caracal-auth" }));
    return;
  }

  if (req.url === "/providers") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(enabledProviders(cfg)));
    return;
  }

  void handler(req, res);
});

server.listen(cfg.port, () => {
  console.log(`caracal-auth listening on ${cfg.baseURL}`);
});
