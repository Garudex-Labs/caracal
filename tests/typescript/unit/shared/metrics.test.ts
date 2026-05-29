// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the Prometheus text-format renderer for observability counters.

import { describe, expect, it } from 'vitest'
import { renderObservabilityMetrics } from '../../../../packages/core/ts/src/metrics.js'
import type { AuditClient, AuditMetrics } from '../../../../packages/core/ts/src/audit.js'

function fakeAudit(metrics: AuditMetrics): AuditClient {
  return { snapshot: () => metrics } as unknown as AuditClient
}

describe('renderObservabilityMetrics', () => {
  it('renders only log counters when no audit client is provided', () => {
    const text = renderObservabilityMetrics()
    expect(text).toContain('# HELP caracal_log_emitted_total Dev log records emitted')
    expect(text).toContain('# TYPE caracal_log_emitted_total counter')
    expect(text).toContain('caracal_log_dropped_total')
    expect(text).toContain('caracal_log_sampled_total')
    expect(text).not.toContain('caracal_audit_emitted_total')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('appends audit counters and gauges when an audit client is provided', () => {
    const metrics: AuditMetrics = {
      emitted: 5,
      dropped: 1,
      persisted: 2,
      drained: 3,
      sink_errors: 4,
      queue_depth: 6,
      queue_cap: 100,
    }
    const text = renderObservabilityMetrics(fakeAudit(metrics))
    expect(text).toContain('caracal_audit_emitted_total 5')
    expect(text).toContain('caracal_audit_dropped_total 1')
    expect(text).toContain('caracal_audit_persisted_total 2')
    expect(text).toContain('caracal_audit_drained_total 3')
    expect(text).toContain('caracal_audit_sink_errors_total 4')
    expect(text).toContain('# TYPE caracal_audit_queue_depth gauge')
    expect(text).toContain('caracal_audit_queue_depth 6')
    expect(text).toContain('caracal_audit_queue_cap 100')
  })
})
