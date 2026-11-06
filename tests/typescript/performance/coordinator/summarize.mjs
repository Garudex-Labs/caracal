// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Keep every run, metric and profiling hash; no selective removal of slow outcomes.
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const dir = resolve(process.argv[2])
const out = resolve(process.argv[3] ?? 'tests/typescript/performance/coordinator/measurements.json')
let environment = { measuredOn: 'not recorded', node: 'not recorded', processor: 'not recorded', postgres: 'not recorded', redis: 'not recorded' }
try { environment = JSON.parse(await readFile(join(dir, 'environment.json'), 'utf8')) } catch (err) { if (err.code !== 'ENOENT') throw err }
const runs = []
for (const name of (await readdir(dir)).filter((s) => /^(before|after)-warm-[12]\.json$/.test(s)).sort()) {
  const data = JSON.parse(await readFile(join(dir, name), 'utf8'))
  if (data.results.length !== 15) throw new Error(`Incomplete matrix: ${name}`)
  for (const r of data.results) {
    const cpuBytes = await readFile(join(dir, `${r.label}.cpuprofile`))
    const heapBytes = await readFile(join(dir, `${r.label}.heapprofile`))
    const cpu = JSON.parse(cpuBytes), heap = JSON.parse(heapBytes)
    const frames = new Map(cpu.nodes.map((n) => [n.id, n.callFrame]))
    const counts = new Map()
    for (let i = 0; i < (cpu.samples ?? []).length; i++) {
      const frame = frames.get(cpu.samples[i])
      const name = `${frame.functionName || '(anonymous)'} @ ${frame.url.split('/').pop()}`
      counts.set(name, (counts.get(name) ?? 0) + (cpu.timeDeltas?.[i] ?? 0))
    }
    const allocations = []
    function visit(node) {
      if (node.selfSize) allocations.push({ function: `${node.callFrame.functionName || '(anonymous)'} @ ${node.callFrame.url.split('/').pop()}`, sampledBytes: node.selfSize })
      for (const child of node.children ?? []) visit(child)
    }
    visit(heap.head)
    const reqs = r.requestTotals?.count ?? r.requests
    runs.push({
      ...r, cpuMsPerRequest: r.cpuMs / r.requests, sampledBytesPerRequest: r.sampledAllocatedBytes / r.requests,
      serverWallMsPerRequest: r.requestTotals.wallMs / reqs,
      serverDependencyMsPerRequest: r.requestTotals.dependencyMs / reqs,
      serverResidualMsPerRequest: r.requestTotals.residualMs / reqs,
      cpuProfileSha256: createHash('sha256').update(cpuBytes).digest('hex'),
      heapProfileSha256: createHash('sha256').update(heapBytes).digest('hex'),
      cpuHotFrames: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([frame, microseconds]) => ({ frame, microseconds })),
      allocationHotFrames: allocations.sort((a, b) => b.sampledBytes - a.sampledBytes).slice(0, 10),
    })
  }
}
if (runs.length !== 60) throw new Error(`Expected 60 cases, found ${runs.length}`)
const metrics = ['requestsPerSecond', 'p50Ms', 'p95Ms', 'p99Ms', 'cpuMsPerRequest', 'sampledBytesPerRequest', 'peakRssBytes', 'peakHeapBytes', 'serverDependencyMsPerRequest', 'serverResidualMsPerRequest']
const comparison = []
for (const kind of ['read', 'replay', 'session', 'invocation', 'delegation']) for (const concurrency of [1, 8, 32]) {
  const row = { kind, concurrency }
  for (const variant of ['before', 'after']) {
    const cases = runs.filter((r) => r.kind === kind && r.concurrency === concurrency && r.label.startsWith(`${variant}-`))
    row[variant] = Object.fromEntries(metrics.map((key) => [key, cases.reduce((sum, r) => sum + r[key], 0) / cases.length]))
  }
  row.changePercent = Object.fromEntries(metrics.map((key) => [key, (row.after[key] / row.before[key] - 1) * 100]))
  comparison.push(row)
}
await writeFile(out, JSON.stringify({
  ...environment,
  conditions: { coordinatorCpu: 14, clientCpu: 15, historyRows: 2000, warmupOperations: 128, measuredOperations: 256, repeats: 2, requestLimits: 'raised identically, not disabled', outboxIntervalMs: 50, dbPoolMax: 20, defaultStatementTimeoutMs: 10000, logLevel: 'warn' },
  notes: ['Comparison values are arithmetic means of two per-run metrics, NOT pooled latency percentiles.', 'Profiler overhead is present equally in both variants.', 'Host is shared with unrelated workloads; unchanged read control and all regressions are retained.', 'Allocation bytes are V8 sampling estimates, not exact allocation counts.'],
  comparison, runs,
}, null, 2) + '\n')
for (const row of comparison) console.log(JSON.stringify({ kind: row.kind, concurrency: row.concurrency, rpsBefore: row.before.requestsPerSecond, rpsAfter: row.after.requestsPerSecond, p95Before: row.before.p95Ms, p95After: row.after.p95Ms, changes: row.changePercent }))
