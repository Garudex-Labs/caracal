// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Statistics for live governed request measurements.

export function percentile(values, percent) {
  if (!values.length) return null
  if (!Number.isFinite(percent) || percent < 0 || percent > 100 || !values.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('invalid percentile input')
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)]
}

export function summarize(samples, elapsedMs) {
  if (!(elapsedMs > 0)) throw new Error('elapsed time must be positive')
  const successful = samples.filter((sample) => sample.ok)
  const latency = successful.map((sample) => sample.durationMs)
  const statuses = {}
  for (const sample of samples) {
    const key = String(sample.status ?? sample.errorCode ?? 'transport_error')
    statuses[key] = (statuses[key] ?? 0) + 1
  }
  return {
    attempted: samples.length,
    succeeded: successful.length,
    failed: samples.length - successful.length,
    errorRate: samples.length ? (samples.length - successful.length) / samples.length : null,
    elapsedMs,
    successfulRequestsPerSecond: successful.length / (elapsedMs / 1000),
    p50Ms: percentile(latency, 50),
    p95Ms: percentile(latency, 95),
    p99Ms: percentile(latency, 99),
    mintP95Ms: percentile(successful.map((sample) => sample.mintMs).filter(Number.isFinite), 95),
    gatewayP95Ms: percentile(successful.map((sample) => sample.gatewayMs).filter(Number.isFinite), 95),
    statuses,
  }
}
