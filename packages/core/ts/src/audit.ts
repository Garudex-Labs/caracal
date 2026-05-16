// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Centralized audit emit client: HMAC-signed events to caracal.audit.events with disk-spill fallback.

import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from './logging.js';
import type { JsonValue } from './json.js';

export const AUDIT_STREAM = 'caracal.audit.events';

/**
 * Canonical audit event. Mirrors packages/core/go/audit/event.go Event struct.
 * JSON field names are the on-the-wire contract; do not rename.
 */
export interface AuditEvent {
  id: string;
  zone_id: string;
  event_type: string;
  request_id: string;
  decision: string;
  policy_set_id?: string;
  policy_set_version_id?: string;
  manifest_sha?: string;
  evaluation_status: string;
  determining_policies_json: JsonValue;
  diagnostics_json: JsonValue;
  metadata_json?: JsonValue;
  occurred_at: string; // RFC3339
}

/**
 * Minimal Redis-stream interface. Pass any client (ioredis, node-redis adapter)
 * that exposes XADD with a flat field/value list.
 */
export interface AuditStreamer {
  xadd(stream: string, ...args: string[]): Promise<string>;
}

export interface AuditMetricsHook {
  onDropped?: (total: number) => void;
  onSinkError?: () => void;
  onReplayPersisted?: (count: number) => void;
  onReplayDrained?: (count: number) => void;
}

export interface AuditClientOptions {
  streamer: AuditStreamer;
  logger: Logger;
  hmacKey?: Buffer | null;
  replayDir: string;
  bufferCap?: number;
  flushBatch?: number;
  flushTtlMs?: number;
  stream?: string;
  production?: boolean;
  metrics?: AuditMetricsHook;
}

export interface AuditMetrics {
  emitted: number;
  dropped: number;
  persisted: number;
  drained: number;
  sink_errors: number;
  queue_depth: number;
  queue_cap: number;
}

export class AuditClient {
  private readonly streamer: AuditStreamer;
  private readonly logger: Logger;
  private readonly hmacKey: Buffer | null;
  private readonly replayDir: string;
  private readonly bufferCap: number;
  private readonly flushBatch: number;
  private readonly flushTtlMs: number;
  private readonly stream: string;
  private readonly metrics: AuditMetricsHook;
  private readonly buffer: AuditEvent[] = [];
  private emittedTotal = 0;
  private droppedTotal = 0;
  private persistedTotal = 0;
  private drainedTotal = 0;
  private sinkErrorsTotal = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private flushing: Promise<void> = Promise.resolve();

  constructor(opts: AuditClientOptions) {
    if (!opts.streamer) throw new Error('audit: streamer is required');
    if (!opts.replayDir) throw new Error('audit: replayDir is required');
    if (opts.production && (!opts.hmacKey || opts.hmacKey.length === 0)) {
      throw new Error('audit: hmacKey is required in production');
    }
    if (opts.hmacKey && opts.hmacKey.length > 0 && opts.hmacKey.length < 32) {
      throw new Error('audit: hmacKey must be at least 32 bytes');
    }
    this.streamer = opts.streamer;
    this.logger = opts.logger;
    this.hmacKey = opts.hmacKey ?? null;
    this.replayDir = opts.replayDir;
    this.bufferCap = opts.bufferCap ?? 10_000;
    this.flushBatch = opts.flushBatch ?? 1_000;
    this.flushTtlMs = opts.flushTtlMs ?? 50;
    this.stream = opts.stream ?? AUDIT_STREAM;
    this.metrics = opts.metrics ?? {};
  }

  async start(): Promise<void> {
    await fs.mkdir(this.replayDir, { recursive: true, mode: 0o700 });
    await this.replayPending();
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushTtlMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * Emit an event. Never blocks. On overflow the event is dropped and counted;
   * on shutdown the unflushed batch is persisted to disk.
   */
  emit(event: AuditEvent): void {
    if (this.closed) return;
    if (this.buffer.length >= this.bufferCap) {
      this.droppedTotal++;
      this.metrics.onDropped?.(this.droppedTotal);
      if (this.droppedTotal === 1 || this.droppedTotal % 1000 === 0) {
        this.logger.warn('audit buffer full', { dropped: this.droppedTotal });
      }
      return;
    }
    this.buffer.push(event);
    this.emittedTotal++;
    if (this.buffer.length >= this.flushBatch) {
      void this.flush();
    }
  }

  dropped(): number {
    return this.droppedTotal;
  }

  snapshot(): AuditMetrics {
    return {
      emitted: this.emittedTotal,
      dropped: this.droppedTotal,
      persisted: this.persistedTotal,
      drained: this.drainedTotal,
      sink_errors: this.sinkErrorsTotal,
      queue_depth: this.buffer.length,
      queue_cap: this.bufferCap,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.flushing;
    await this.flush();
    if (this.buffer.length > 0) {
      await this.persistBatch(this.buffer.splice(0, this.buffer.length));
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    this.flushing = this.flushing.then(async () => {
      const failed: AuditEvent[] = [];
      for (const ev of batch) {
        try {
          await this.xadd(ev);
        } catch (err) {
          this.logger.error('xadd audit event', { id: ev.id, err: err instanceof Error ? err.message : String(err) });
          this.sinkErrorsTotal++;
          this.metrics.onSinkError?.();
          failed.push(ev);
        }
      }
      if (failed.length > 0) await this.persistBatch(failed);
    });
    await this.flushing;
  }

  private sign(data: string): string | null {
    if (!this.hmacKey) return null;
    return createHmac('sha256', this.hmacKey).update(data).digest('hex');
  }

  private async xadd(ev: AuditEvent): Promise<void> {
    const data = JSON.stringify(ev);
    const args: string[] = ['*', 'id', ev.id, 'data', data];
    const sig = this.sign(data);
    if (sig) args.push('sig', sig);
    await this.streamer.xadd(this.stream, ...args);
  }

  private async persistBatch(batch: AuditEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const name = `pending-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`;
    const path = join(this.replayDir, name);
    try {
      const body = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(path, body, { mode: 0o600 });
      this.persistedTotal += batch.length;
      this.metrics.onReplayPersisted?.(batch.length);
      this.logger.warn('audit batch persisted to disk for later replay', { path, count: batch.length });
    } catch (err) {
      this.logger.error('audit replay file write', { path, err: err instanceof Error ? err.message : String(err) });
    }
  }

  private async replayPending(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.replayDir);
    } catch (err) {
      this.logger.error('audit replay dir scan', { dir: this.replayDir, err: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const name of entries) {
      if (!name.endsWith('.ndjson')) continue;
      const path = join(this.replayDir, name);
      try {
        const body = await fs.readFile(path, 'utf8');
        let drained = 0;
        for (const line of body.split('\n')) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as AuditEvent;
          await this.xadd(ev);
          drained++;
        }
        this.drainedTotal += drained;
        this.metrics.onReplayDrained?.(drained);
        await fs.unlink(path);
        this.logger.info('audit replay file drained', { path, count: drained });
      } catch (err) {
        this.logger.error('audit replay file failed; will retry on next start', { path, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

export function defaultReplayDir(service: string): string {
  return join(tmpdir(), 'caracal-audit-replay', service);
}

/**
 * Install SIGTERM/SIGINT handlers that flush the audit client before exit.
 * Returns a stop function that removes the handlers (useful for tests).
 */
export function installShutdownHandler(client: AuditClient, timeoutMs = 2000): () => void {
  const handler = () => {
    const t = setTimeout(() => process.exit(1), timeoutMs).unref();
    client.close().finally(() => {
      clearTimeout(t);
      process.exit(0);
    });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}
