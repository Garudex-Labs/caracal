// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Prometheus text-format renderer for Caracal counter snapshots.

import { devLogMetrics } from './logging.js';
import type { AuditClient } from './audit.js';

type Counter = { name: string; help: string; value: number };

function renderCounters(counters: Counter[]): string {
  const lines: string[] = [];
  for (const c of counters) {
    lines.push(`# HELP ${c.name} ${c.help}`);
    lines.push(`# TYPE ${c.name} counter`);
    lines.push(`${c.name} ${c.value}`);
  }
  return lines.join('\n') + '\n';
}

function renderGauges(gauges: Counter[]): string {
  const lines: string[] = [];
  for (const g of gauges) {
    lines.push(`# HELP ${g.name} ${g.help}`);
    lines.push(`# TYPE ${g.name} gauge`);
    lines.push(`${g.name} ${g.value}`);
  }
  return lines.join('\n') + '\n';
}

/** Render dev-log + (optional) audit counters in Prometheus text format. */
export function renderObservabilityMetrics(audit?: AuditClient): string {
  const log = devLogMetrics();
  const counters: Counter[] = [
    { name: 'caracal_log_emitted_total', help: 'Dev log records emitted', value: log.emitted },
    { name: 'caracal_log_dropped_total', help: 'Dev log records dropped due to backpressure', value: log.dropped },
    { name: 'caracal_log_sampled_total', help: 'Debug log records dropped by sampler', value: log.sampled },
  ];
  if (audit) {
    const a = audit.snapshot();
    counters.push(
      { name: 'caracal_audit_emitted_total', help: 'Audit events accepted into buffer', value: a.emitted },
      { name: 'caracal_audit_dropped_total', help: 'Audit events dropped due to full buffer', value: a.dropped },
      { name: 'caracal_audit_persisted_total', help: 'Audit events spilled to disk for later replay', value: a.persisted },
      { name: 'caracal_audit_drained_total', help: 'Audit events replayed from disk', value: a.drained },
      { name: 'caracal_audit_sink_errors_total', help: 'Audit sink (XADD) errors', value: a.sink_errors },
    );
    const gauges: Counter[] = [
      { name: 'caracal_audit_queue_depth', help: 'Audit buffer depth', value: a.queue_depth },
      { name: 'caracal_audit_queue_cap', help: 'Audit buffer capacity', value: a.queue_cap },
    ];
    return renderCounters(counters) + renderGauges(gauges);
  }
  return renderCounters(counters);
}
