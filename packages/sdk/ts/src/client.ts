/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
 */

import { bind, fromEnvelope, toEnvelope, current, type CaracalContext } from "./context.js";
import {
  decodeEnvelope,
  toHeaders,
  type Envelope,
  type HeaderGetter,
} from "./envelope.js";
import { type CoordinatorClient } from "./coordinator.js";
import {
  spawn as spawnPrimitive,
  delegate as delegatePrimitive,
  delegateToSpawn as delegateToSpawnPrimitive,
  type SpawnInput,
  type DelegateInput,
  type DelegateToSpawnInput,
} from "./primitives.js";
import { AgentKind, type DelegationConstraints } from "./coordinator.js";
import type { JsonObject } from "./json.js";
import { OAuthClient } from "@caracalai/oauth";

export interface ResourceBinding {
  resourceId: string;
  upstreamPrefix: string;
}

export type TokenSource = () => string | Promise<string>;

export interface CaracalConfig {
  coordinator: CoordinatorClient;
  zoneId: string;
  applicationId: string;
  subjectToken?: string;
  tokenSource?: TokenSource;
  gatewayUrl?: string;
  resources?: ResourceBinding[];
  defaultKind?: AgentKind;
  defaultTtlSeconds?: number;
}

export interface SpawnOptions {
  kind?: AgentKind;
  ttlSeconds?: number;
  subjectSessionId?: string;
  parentId?: string;
  metadata?: JsonObject;
  traceId?: string;
}

export interface DelegateOptions {
  to: string;
  toApplicationId: string;
  resourceId?: string;
  scopes: string[];
  constraints?: DelegationConstraints;
  ttlSeconds?: number;
}

export interface DelegateToSpawnOptions {
  resourceId?: string;
  scopes: string[];
  constraints?: DelegationConstraints;
  delegationTtlSeconds?: number;
  kind?: AgentKind;
  ttlSeconds?: number;
  metadata?: JsonObject;
  traceId?: string;
}

export type LifecycleHook = (ctx: CaracalContext) => void | Promise<void>;

export interface RootOptions {
  allowRoot?: boolean;
}

export interface ClientSecretOptions {
  coordinatorUrl: string;
  stsUrl: string;
  zoneId: string;
  applicationId: string;
  clientSecret: string;
  resources: string[] | ResourceBinding[];
  gatewayUrl?: string;
  scope?: string;
}

export class Caracal {
  private agentStartHooks: LifecycleHook[] = [];
  private agentEndHooks: LifecycleHook[] = [];

  constructor(public readonly config: CaracalConfig) {
    if ((config.subjectToken === undefined) === (config.tokenSource === undefined)) {
      throw new Error("CaracalConfig requires exactly one of subjectToken or tokenSource");
    }
    if (config.resources && config.resources.length > 1) {
      this.config = { ...config, resources: sortBindingsLongestFirst(config.resources) };
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Caracal {
    const url = env.CARACAL_COORDINATOR_URL;
    const zoneId = env.CARACAL_ZONE_ID;
    const applicationId = env.CARACAL_APPLICATION_ID;
    const subjectToken = env.CARACAL_SUBJECT_TOKEN;
    const clientSecret = env.CARACAL_APP_CLIENT_SECRET;
    const stsUrl = env.CARACAL_STS_URL;
    const gatewayUrl = env.CARACAL_GATEWAY_URL;
    const missing = [
      ["CARACAL_COORDINATOR_URL", url],
      ["CARACAL_ZONE_ID", zoneId],
      ["CARACAL_APPLICATION_ID", applicationId],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(`Caracal.fromEnv: missing ${missing.join(", ")}`);
    }
    const resources = parseResourceBindings(env.CARACAL_RESOURCES);
    if (clientSecret) {
      if (!stsUrl) throw new Error("Caracal.fromEnv: CARACAL_APP_CLIENT_SECRET requires CARACAL_STS_URL");
      return Caracal.fromClientSecret({
        coordinatorUrl: url!,
        stsUrl,
        zoneId: zoneId!,
        applicationId: applicationId!,
        clientSecret,
        resources: resourceIdsFromEnv(env.CARACAL_APP_RESOURCES, resources),
        gatewayUrl,
      });
    }
    if (!subjectToken) {
      throw new Error("Caracal.fromEnv: provide CARACAL_APP_CLIENT_SECRET (+ CARACAL_STS_URL) or CARACAL_SUBJECT_TOKEN");
    }
    validateSubjectToken(subjectToken!);
    return new Caracal({
      coordinator: { baseUrl: url! },
      zoneId: zoneId!,
      applicationId: applicationId!,
      subjectToken: subjectToken!,
      gatewayUrl,
      resources,
    });
  }

  static fromClientSecret(opts: ClientSecretOptions): Caracal {
    const resourceIds = opts.resources.map((value) => typeof value === "string" ? value : value.resourceId);
    if (!resourceIds.length) throw new Error("Caracal.fromClientSecret requires at least one resource");
    const bindings = opts.resources.every((value) => typeof value !== "string")
      ? opts.resources as ResourceBinding[]
      : undefined;
    return new Caracal({
      coordinator: { baseUrl: opts.coordinatorUrl },
      zoneId: opts.zoneId,
      applicationId: opts.applicationId,
      tokenSource: createClientSecretTokenSource(opts.stsUrl, opts.zoneId, opts.applicationId, opts.clientSecret, resourceIds, opts.scope),
      gatewayUrl: opts.gatewayUrl,
      resources: bindings,
    });
  }

  async close(): Promise<void> {
  }

  async spawn<T>(fn: () => Promise<T>, opts: SpawnOptions = {}): Promise<T> {
    const input: SpawnInput = {
      coordinator: this.config.coordinator,
      zoneId: this.config.zoneId,
      applicationId: this.config.applicationId,
      subjectToken: await this.rootToken(),
      kind: opts.kind ?? this.config.defaultKind ?? AgentKind.Instance,
      ttlSeconds: opts.ttlSeconds ?? this.config.defaultTtlSeconds,
      subjectSessionId: opts.subjectSessionId,
      parentId: opts.parentId,
      metadata: opts.metadata,
      traceId: opts.traceId,
      onAgentStart: this.agentStartHooks.length ? (c) => this.fire(this.agentStartHooks, c) : undefined,
      onAgentEnd: this.agentEndHooks.length ? (c) => this.fire(this.agentEndHooks, c) : undefined,
    };
    return await spawnPrimitive(input, fn);
  }

  delegate<T>(opts: DelegateOptions, fn: () => Promise<T>): Promise<T> {
    const input: DelegateInput = {
      coordinator: this.config.coordinator,
      toAgentSessionId: opts.to,
      toApplicationId: opts.toApplicationId,
      resourceId: opts.resourceId,
      scopes: opts.scopes,
      constraints: opts.constraints,
      ttlSeconds: opts.ttlSeconds,
    };
    return delegatePrimitive(input, fn);
  }

  async delegateToSpawn<T>(opts: DelegateToSpawnOptions, fn: () => Promise<T>): Promise<T> {
    const input: DelegateToSpawnInput = {
      coordinator: this.config.coordinator,
      zoneId: this.config.zoneId,
      applicationId: this.config.applicationId,
      subjectToken: await this.rootToken(),
      resourceId: opts.resourceId,
      scopes: opts.scopes,
      constraints: opts.constraints,
      delegationTtlSeconds: opts.delegationTtlSeconds,
      kind: opts.kind ?? this.config.defaultKind ?? AgentKind.Instance,
      ttlSeconds: opts.ttlSeconds ?? this.config.defaultTtlSeconds,
      metadata: opts.metadata,
      traceId: opts.traceId,
      onAgentStart: this.agentStartHooks.length ? (c) => this.fire(this.agentStartHooks, c) : undefined,
      onAgentEnd: this.agentEndHooks.length ? (c) => this.fire(this.agentEndHooks, c) : undefined,
    };
    return await delegateToSpawnPrimitive(input, fn);
  }

  bind<T>(ctx: CaracalContext, fn: () => Promise<T>): Promise<T> {
    return bind(ctx, fn) as Promise<T>;
  }

  onAgentStart(cb: LifecycleHook): void {
    this.agentStartHooks.push(cb);
  }

  onAgentEnd(cb: LifecycleHook): void {
    this.agentEndHooks.push(cb);
  }

  private async fire(hooks: LifecycleHook[], ctx: CaracalContext): Promise<void> {
    for (const h of hooks) await h(ctx);
  }

  current(): CaracalContext | undefined {
    return current();
  }

  headers(opts: RootOptions = {}): Record<string, string> {
    const ctx = current();
    if (!ctx) {
      if (!opts.allowRoot) {
        throw new Error(
          "Caracal.headers(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.",
        );
      }
      return toHeaders({
        subjectToken: this.rootTokenSync(),
        hop: 0,
      });
    }
    return toHeaders(toEnvelope(ctx));
  }

  async headersAsync(opts: RootOptions = {}): Promise<Record<string, string>> {
    const ctx = current();
    if (!ctx) {
      if (!opts.allowRoot) {
        throw new Error(
          "Caracal.headersAsync(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.",
        );
      }
      return toHeaders({ subjectToken: await this.rootToken(), hop: 0 });
    }
    return toHeaders(toEnvelope(ctx));
  }

  async bindFromHeaders<T>(
    headers: Record<string, string | string[] | undefined> | HeaderGetter,
    fn: () => Promise<T>,
    opts: RootOptions = {},
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
    if (!env.subjectToken) {
      if (!opts.allowRoot) {
        throw new Error(
          "Caracal.bindFromHeaders(): inbound request is missing a bearer token. Pass { allowRoot: true } only for trusted service-root ingress.",
        );
      }
      env.subjectToken = await this.rootToken();
    }
    const ctx = fromEnvelope(env as Envelope, {
      zoneId: this.config.zoneId,
      clientId: this.config.applicationId,
    });
    return await bind(ctx, fn) as T;
  }

  /**
   * Returns a fetch-shaped function that injects the Caracal envelope (traceparent
   * + baggage) onto outbound requests and, for gateway-routed calls, replaces the
   * `Authorization` header with the current subject token. Pass to any provider
   * SDK that accepts a custom fetch.
   */
  transport(opts: RootOptions = {}): typeof fetch {
    const outer = this;
    const rootAllowed = opts.allowRoot === true;
    const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const ctx = current();
      if (!ctx && !rootAllowed) {
        throw new Error(
          "Caracal.transport(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.",
        );
      }
      const env: Envelope = ctx ? toEnvelope(ctx) : { subjectToken: await outer.rootToken(), hop: 0 };
      const merged = new Headers(init?.headers ?? {});
      for (const [k, v] of Object.entries(toHeaders(env))) {
        if (!merged.has(k)) merged.set(k, v);
      }
      const fetchImpl = outer.config.coordinator.fetchImpl ?? fetch;

      const explicitResource = merged.get("X-Caracal-Resource") ?? undefined;
      const rewritten = outer.routeThroughGateway(input, explicitResource);
      if (rewritten) {
        merged.set("X-Caracal-Resource", rewritten.resourceId);
        merged.set("Authorization", `Bearer ${env.subjectToken}`);
        return fetchImpl(rewritten.url as unknown as URL, { ...init, headers: merged });
      }
      return fetchImpl(input as URL, { ...init, headers: merged });
    }) as typeof fetch;
    return fn;
  }

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
    const base = gateway.origin + gateway.pathname.replace(/\/$/, "");
    const target = base + suffix;
    return { url: target, resourceId: binding?.resourceId ?? explicitResource! };
  }

  middleware(opts: RootOptions = {}) {
    return (
      req: { headers: Record<string, string | string[] | undefined> },
      _res: unknown,
      next: (err?: unknown) => void,
    ): void => {
      this.bindFromHeaders(req.headers, async () => {
        next();
      }, opts).catch(next);
    };
  }

  private rootTokenSync(): string {
    if (this.config.subjectToken) return this.config.subjectToken;
    throw new Error("Caracal.headers(): this client uses an async token source. Use headersAsync({ allowRoot: true }) for root headers.");
  }

  private async rootToken(): Promise<string> {
    if (this.config.tokenSource) return await this.config.tokenSource();
    if (this.config.subjectToken) return this.config.subjectToken;
    throw new Error("Caracal client has no subject token source");
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
  const errors: string[] = [];
  for (const [index, entry] of raw.split(",").entries()) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      errors.push(`entry ${index + 1} must use resourceId=upstreamPrefix`);
      continue;
    }
    const resourceId = trimmed.slice(0, idx).trim();
    const upstreamPrefix = trimmed.slice(idx + 1).trim();
    if (!resourceId || !upstreamPrefix) {
      errors.push(`entry ${index + 1} must contain non-empty resourceId and upstreamPrefix`);
      continue;
    }
    try {
      new URL(upstreamPrefix);
    } catch {
      errors.push(`entry ${index + 1} upstreamPrefix must be an absolute URL`);
      continue;
    }
    out.push({ resourceId, upstreamPrefix });
  }
  if (errors.length) {
    throw new Error(`Caracal.fromEnv: invalid CARACAL_RESOURCES:\n- ${errors.join("\n- ")}`);
  }
  return out.length ? sortBindingsLongestFirst(out) : undefined;
}

function resourceIdsFromEnv(raw: string | undefined, bindings: ResourceBinding[] | undefined): string[] {
  const explicit = raw?.split(",").map((value) => value.trim()).filter(Boolean);
  if (explicit?.length) return explicit;
  if (bindings?.length) return bindings.map((binding) => binding.resourceId);
  throw new Error("Caracal.fromEnv: client-secret mode requires resources via CARACAL_APP_RESOURCES or CARACAL_RESOURCES");
}

function createClientSecretTokenSource(
  stsUrl: string,
  zoneId: string,
  applicationId: string,
  clientSecret: string,
  resources: string[],
  scope = "agent:lifecycle",
): TokenSource {
  const client = new OAuthClient(stsUrl, zoneId, applicationId);
  return async () => {
    const token = await client.exchange("", resources, { clientSecret, scopes: [scope] });
    return token.accessToken;
  };
}

function sortBindingsLongestFirst(bindings: ResourceBinding[]): ResourceBinding[] {
  return [...bindings].sort((a, b) => b.upstreamPrefix.length - a.upstreamPrefix.length);
}

/**
 * Local sanity check on the bootstrap subject token. When the token has a JWT
 * shape, decodes the payload and rejects tokens that are malformed or already
 * expired. Opaque tokens are accepted.
 */
function validateSubjectToken(token: string): void {
  const parts = token.split(".");
  if (parts.length !== 3) return;
  let payloadJson: string;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    payloadJson = typeof Buffer !== "undefined"
      ? Buffer.from(b64, "base64").toString("utf-8")
      : atob(b64);
  } catch {
    return;
  }
  let payload: { exp?: number };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return;
  }
  if (typeof payload.exp !== "number") return;
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error(
      "CARACAL_SUBJECT_TOKEN is expired — refresh the bootstrap token before starting the application",
    );
  }
}
