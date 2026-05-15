// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Structured JSON logger for TypeScript services.

import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import type { Writable } from 'node:stream';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_VALUE: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/**
 * Field names whose values must never appear in dev logs. Mirror this list in
 * packages/core/go/logging/redact.go and packages/core/python/caracalai_core/logging.py.
 */
export const SECRET_KEYS: readonly string[] = Object.freeze([
  'password',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'client_secret',
  'private_key',
  'session',
  'assertion',
  'authorization',
  'cookie',
  'set_cookie',
  'set-cookie',
  'hmac',
  'signature',
]);

export const REDACT_VALUE = '***';

const BEARER_PATTERN = /bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const AWS_AKIA = /AKIA[0-9A-Z]{16}/g;
const AWS_ASIA = /ASIA[0-9A-Z]{16}/g;
const GCP_KEY = /AIza[0-9A-Za-z_-]{35}/g;
const GITHUB_PAT = /gh[pousr]_[A-Za-z0-9]{36,255}/g;
const SLACK_TOKEN = /xox[abprs]-[A-Za-z0-9-]{10,}/g;
const PEM_BLOCK = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g;

export const MAX_FIELD_BYTES = (() => {
  const v = process.env.CARACAL_LOG_MAX_FIELD_BYTES;
  if (v) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return 8192;
})();

export function isSecretKey(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_KEYS.some((k) => lower.includes(k));
}

/**
 * Scrub Bearer tokens, JWT-shaped substrings, and common cloud secret patterns
 * (AWS, GCP, GitHub, Slack, PEM keys) from a string. Cheap on the common path.
 */
export function redactString(s: string): string {
  if (s.length < 16) return s;
  let out = s.replace(PEM_BLOCK, REDACT_VALUE);
  out = out.replace(BEARER_PATTERN, `Bearer ${REDACT_VALUE}`);
  out = out.replace(JWT_PATTERN, REDACT_VALUE);
  out = out.replace(AWS_AKIA, REDACT_VALUE);
  out = out.replace(AWS_ASIA, REDACT_VALUE);
  out = out.replace(GCP_KEY, REDACT_VALUE);
  out = out.replace(GITHUB_PAT, REDACT_VALUE);
  out = out.replace(SLACK_TOKEN, REDACT_VALUE);
  return out;
}

export function truncateString(s: string): string {
  if (MAX_FIELD_BYTES <= 0 || s.length <= MAX_FIELD_BYTES) return s;
  return s.slice(0, MAX_FIELD_BYTES) + '…[truncated]';
}

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  if (err.stack) out.stack = err.stack;
  const code = (err as Error & { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause !== undefined) out.cause = cause instanceof Error ? serializeError(cause) : cause;
  return out;
}

/**
 * Returns a deep copy of `value` with any field whose key matches SECRET_KEYS
 * replaced with REDACT_VALUE, string values scrubbed of token-like patterns
 * and truncated to MAX_FIELD_BYTES, and Error instances flattened to plain
 * JSON-friendly objects.
 */
export function redact<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(redactString(value)) as unknown as T;
  if (value instanceof Error) return serializeError(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? REDACT_VALUE : redact(v);
  }
  return out as T;
}

export type TraceContext = { traceId?: string; spanId?: string };

const traceStore = new AsyncLocalStorage<TraceContext>();

/** Run `fn` with the provided trace context bound to the async chain. */
export function runWithTrace<R>(tc: TraceContext, fn: () => R): R {
  return traceStore.run(tc, fn);
}

/** Enter a trace context for the remainder of the current async chain. */
export function bindTrace(tc: TraceContext): void {
  traceStore.enterWith(tc);
}

/** Returns the trace context bound to the current async chain, or undefined. */
export function getTraceContext(): TraceContext | undefined {
  return traceStore.getStore();
}

/** Parse a W3C traceparent header (`version-traceid-spanid-flags`). */
export function parseTraceparent(h: string | undefined): TraceContext {
  if (!h) return {};
  const parts = h.split('-');
  if (parts.length < 4) return {};
  if (parts[1].length !== 32 || parts[2].length !== 16) return {};
  return { traceId: parts[1], spanId: parts[2] };
}

/** Returns a pino-compatible mixin function that injects trace fields. */
export function traceMixin(): () => Record<string, unknown> {
  return () => {
    const tc = getTraceContext();
    const out: Record<string, unknown> = {};
    if (tc?.traceId) out.trace_id = tc.traceId;
    if (tc?.spanId) out.span_id = tc.spanId;
    return out;
  };
}

export type Logger = {
  level: Level;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  fatal: (msg: string, fields?: Record<string, unknown>) => void;
  with: (fields: Record<string, unknown>) => Logger;
  metrics: () => DevLogMetrics;
};

export type DevLogMetrics = {
  emitted: number;
  dropped: number;
  sampled: number;
};

const metricsState = { emitted: 0, dropped: 0, sampled: 0 };

export function devLogMetrics(): DevLogMetrics {
  return { ...metricsState };
}

const DEBUG_SAMPLE_N = (() => {
  const v = process.env.CARACAL_LOG_SAMPLE_DEBUG;
  if (v) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
})();

let debugCounter = 0;

export interface CreateLoggerOptions {
  level?: Level;
  hostname?: string;
  pid?: number;
  version?: string;
  env?: string;
  stream?: Writable;
}

let cachedHostname: string | null = null;
function host(): string {
  if (cachedHostname === null) {
    try { cachedHostname = hostname(); } catch { cachedHostname = 'unknown'; }
  }
  return cachedHostname;
}

function processBaseFields(): Record<string, unknown> {
  return {
    hostname: host(),
    pid: process.pid,
    version: process.env.CARACAL_VERSION || process.env.npm_package_version || 'dev',
    env: process.env.CARACAL_ENV || process.env.NODE_ENV || 'development',
  };
}

function envLevel(): Level {
  const raw = (process.env.CARACAL_LOG_LEVEL || process.env.LOG_LEVEL || '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'fatal') return raw;
  return 'info';
}

export function createLogger(service: string, levelOrOpts?: Level | CreateLoggerOptions): Logger {
  const opts: CreateLoggerOptions = typeof levelOrOpts === 'string' ? { level: levelOrOpts } : (levelOrOpts ?? {});
  const level: Level = opts.level ?? envLevel();
  const baseFields: Record<string, unknown> = {
    service,
    ...processBaseFields(),
    ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
    ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
  return makeLogger(baseFields, level, opts.stream ?? process.stderr);
}

function makeLogger(
  bound: Record<string, unknown>,
  level: Level,
  stream: NodeJS.WritableStream,
): Logger {
  const threshold = LEVEL_VALUE[level];
  const emit = (msgLevel: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_VALUE[msgLevel] < threshold) return;
    if (msgLevel === 'debug' && DEBUG_SAMPLE_N > 1) {
      debugCounter = (debugCounter + 1) >>> 0;
      if (debugCounter % DEBUG_SAMPLE_N !== 0) {
        metricsState.sampled++;
        return;
      }
    }
    const tc = getTraceContext();
    const traceFields: Record<string, unknown> = {};
    if (tc?.traceId) traceFields.trace_id = tc.traceId;
    if (tc?.spanId) traceFields.span_id = tc.spanId;
    const safe = fields ? (redact(fields) as Record<string, unknown>) : undefined;
    const line = JSON.stringify({
      level: msgLevel,
      time: new Date().toISOString(),
      ...bound,
      ...traceFields,
      msg,
      ...safe,
    }) + '\n';
    const ok = stream.write(line);
    if (ok) metricsState.emitted++;
    else metricsState.dropped++;
  };
  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    fatal: (msg, fields) => emit('fatal', msg, fields),
    with: (fields) => makeLogger({ ...bound, ...(redact(fields) as Record<string, unknown>) }, level, stream),
    metrics: () => devLogMetrics(),
  };
}



