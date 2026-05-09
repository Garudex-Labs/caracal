/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
 */

import { bind, fromEnvelope, toEnvelope, tryCurrent, type CaracalContext } from "./context.js";
import {
  decodeEnvelope,
  toHeaders,
  type Envelope,
  type HeaderGetter,
} from "./envelope.js";
import { type CoordinatorClient } from "./coordinator.js";
import { withAgent, withDelegation, type WithAgentOptions, type WithDelegationOptions } from "./primitives.js";

export interface ResourceBinding {
  resourceId: string;
  upstreamPrefix: string;
}

export interface CaracalConfig {
  coordinator: CoordinatorClient;
  zoneId: string;
  applicationId: string;
  subjectToken: string;
  gatewayUrl?: string;
  resources?: ResourceBinding[];
  defaultKind?: "service" | "instance" | "ephemeral";
  defaultTtlSeconds?: number;
}

export interface RunOptions {
  kind?: "service" | "instance" | "ephemeral";
  ttlSeconds?: number;
  sessionSid?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
}

export interface DelegateOptions {
  to: string;
  toApplicationId: string;
  scopes: string[];
  constraints?: Record<string, unknown>;
  ttlSeconds?: number;
}

export class Caracal {
  constructor(public readonly config: CaracalConfig) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Caracal {
    const url = env.CARACAL_COORDINATOR_URL;
    const zoneId = env.CARACAL_ZONE_ID;
    const applicationId = env.CARACAL_APPLICATION_ID;
    const subjectToken = env.CARACAL_SUBJECT_TOKEN;
    const gatewayUrl = env.CARACAL_GATEWAY_URL;
    const missing = [
      ["CARACAL_COORDINATOR_URL", url],
      ["CARACAL_ZONE_ID", zoneId],
      ["CARACAL_APPLICATION_ID", applicationId],
      ["CARACAL_SUBJECT_TOKEN", subjectToken],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(`Caracal.fromEnv: missing ${missing.join(", ")}`);
    }
    return new Caracal({
      coordinator: { baseUrl: url! },
      zoneId: zoneId!,
      applicationId: applicationId!,
      subjectToken: subjectToken!,
      gatewayUrl,
      resources: parseResourceBindings(env.CARACAL_RESOURCES),
    });
  }

  run<T>(fn: () => Promise<T>, opts: RunOptions = {}): Promise<T> {
    const full: WithAgentOptions = {
      coordinator: this.config.coordinator,
      zoneId: this.config.zoneId,
      applicationId: this.config.applicationId,
      subjectToken: this.config.subjectToken,
      kind: opts.kind ?? this.config.defaultKind ?? "instance",
      ttlSeconds: opts.ttlSeconds ?? this.config.defaultTtlSeconds,
      sessionSid: opts.sessionSid,
      parentId: opts.parentId,
      metadata: opts.metadata,
      traceId: opts.traceId,
    };
    return withAgent(full, fn);
  }

  delegate<T>(opts: DelegateOptions, fn: () => Promise<T>): Promise<T> {
    const full: WithDelegationOptions = {
      coordinator: this.config.coordinator,
      toAgentSessionId: opts.to,
      toApplicationId: opts.toApplicationId,
      scopes: opts.scopes,
      constraints: opts.constraints,
      ttlSeconds: opts.ttlSeconds,
    };
    return withDelegation(full, fn) as Promise<T>;
  }

  headers(): Record<string, string> {
    const ctx = tryCurrent();
    if (!ctx) {
      return toHeaders({
        subjectToken: this.config.subjectToken,
        hop: 0,
      });
    }
    return toHeaders(toEnvelope(ctx));
  }

  bindFromHeaders<T>(
    headers: Record<string, string | string[] | undefined> | HeaderGetter,
    fn: () => Promise<T>,
  ): Promise<T> {
    const env = typeof headers === "function"
      ? decodeEnvelope(headers)
      : decodeEnvelope((n) => {
          const lower = n.toLowerCase();
          for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === lower) {
              const v = (headers as Record<string, string | string[] | undefined>)[k];
              return Array.isArray(v) ? v[0] : v;
            }
          }
          return undefined;
        });
    if (!env.subjectToken) env.subjectToken = this.config.subjectToken;
    const ctx = fromEnvelope(env as Envelope, {
      zoneId: this.config.zoneId,
      clientId: this.config.applicationId,
    });
    return bind(ctx, fn) as Promise<T>;
  }

  fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const ctx = tryCurrent();
    const env: Envelope = ctx
      ? toEnvelope(ctx)
      : { subjectToken: this.config.subjectToken, hop: 0 };
    const merged = new Headers(init?.headers ?? {});
    for (const [k, v] of Object.entries(toHeaders(env))) {
      if (!merged.has(k)) merged.set(k, v);
    }
    const fetchImpl = this.config.coordinator.fetchImpl ?? fetch;

    const explicitResource = merged.get("X-Caracal-Resource") ?? undefined;
    const rewritten = this.routeThroughGateway(input, explicitResource);
    if (rewritten) {
      merged.set("X-Caracal-Resource", rewritten.resourceId);
      merged.set("Authorization", `Bearer ${env.subjectToken ?? this.config.subjectToken}`);
      return fetchImpl(rewritten.url as unknown as URL, { ...init, headers: merged });
    }
    return fetchImpl(input as URL, { ...init, headers: merged });
  }) as typeof fetch;

  private routeThroughGateway(
    input: RequestInfo | URL,
    explicitResource: string | undefined,
  ): { url: string; resourceId: string } | null {
    const gw = this.config.gatewayUrl;
    if (!gw) return null;
    const raw = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (sameOrigin(parsed, gw)) return null;

    const binding = explicitResource
      ? this.config.resources?.find((b) => b.resourceId === explicitResource)
      : this.config.resources?.find((b) => urlMatchesPrefix(parsed, b.upstreamPrefix));
    if (!binding && !explicitResource) return null;

    const gateway = new URL(gw);
    let suffix = parsed.pathname + parsed.search;
    if (binding) {
      const prefix = new URL(binding.upstreamPrefix);
      if (parsed.pathname.startsWith(prefix.pathname) && prefix.pathname !== "/") {
        suffix = parsed.pathname.slice(prefix.pathname.length) + parsed.search;
        if (!suffix.startsWith("/")) suffix = "/" + suffix;
      }
    }
    const target = gateway.toString().replace(/\/$/, "") + suffix;
    return { url: target, resourceId: binding?.resourceId ?? explicitResource! };
  }

  context(): CaracalContext {
    const ctx = tryCurrent();
    if (!ctx) throw new Error("Caracal context is not bound on this execution path");
    return ctx;
  }

  tryContext(): CaracalContext | undefined {
    return tryCurrent();
  }

  middleware() {
    return (
      req: { headers: Record<string, string | string[] | undefined> },
      _res: unknown,
      next: (err?: unknown) => void,
    ): void => {
      this.bindFromHeaders(req.headers, async () => {
        next();
      }).catch(next);
    };
  }
}

function sameOrigin(a: URL, b: string): boolean {
  try {
    const o = new URL(b);
    return a.protocol === o.protocol && a.host === o.host;
  } catch {
    return false;
  }
}

function urlMatchesPrefix(target: URL, prefix: string): boolean {
  let p: URL;
  try {
    p = new URL(prefix);
  } catch {
    return false;
  }
  if (p.protocol !== target.protocol) return false;
  if (p.host !== target.host) return false;
  if (p.pathname === "/" || p.pathname === "") return true;
  return target.pathname === p.pathname || target.pathname.startsWith(p.pathname.endsWith("/") ? p.pathname : p.pathname + "/");
}

function parseResourceBindings(raw: string | undefined): ResourceBinding[] | undefined {
  if (!raw) return undefined;
  const out: ResourceBinding[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const resourceId = trimmed.slice(0, idx).trim();
    const upstreamPrefix = trimmed.slice(idx + 1).trim();
    if (resourceId && upstreamPrefix) {
      out.push({ resourceId, upstreamPrefix });
    }
  }
  return out.length ? out : undefined;
}
