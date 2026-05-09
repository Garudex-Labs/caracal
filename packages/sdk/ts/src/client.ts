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

export interface CaracalConfig {
  coordinator: CoordinatorClient;
  zoneId: string;
  applicationId: string;
  subjectToken: string;
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
    return fetchImpl(input as URL, { ...init, headers: merged });
  }) as typeof fetch;

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
