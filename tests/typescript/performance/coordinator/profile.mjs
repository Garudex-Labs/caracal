// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Test-only preload: instruments real Coordinator dependencies, never records parameters or tokens.
import { createRequire } from 'node:module'
import { createServer, Server } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Session } from 'node:inspector/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Load the service's declared dependency graph, not a phantom root dependency.
const coordinatorRequire = createRequire(resolve(process.env.PERF_MODULE_ROOT ?? 'apps/coordinator/package.json'))
const pg = coordinatorRequire('pg')
const Redis = coordinatorRequire('ioredis')
const sampling = process.env.PERF_LIGHT !== '1'
const inspector = new Session()
if (sampling) inspector.connect()
const loop = monitorEventLoopDelay({ resolution: 10 })
loop.enable()
let active = false
let stats = new Map()
let cpu, started, peakRss = 0, peakHeap = 0
let requestTotals = { count: 0, wallMs: 0, dependencyMs: 0, residualMs: 0 }
const requests = new AsyncLocalStorage()
const emit = Server.prototype.emit
Server.prototype.emit = function (event, req, res, ...args) {
  if (event !== 'request' || req.socket.localPort !== Number(process.env.PORT ?? 4000)) return emit.call(this, event, req, res, ...args)
  const sample = { started: performance.now(), dependencyMs: 0, measured: active }
  return requests.run(sample, () => {
    res.once('finish', () => {
      if (!sample.measured || !active) return
      const ms = performance.now() - sample.started
      requestTotals.count++
      requestTotals.wallMs += ms
      requestTotals.dependencyMs += sample.dependencyMs
      requestTotals.residualMs += Math.max(0, ms - sample.dependencyMs)
    })
    return emit.call(this, event, req, res, ...args)
  })
}
const record = (key, start) => {
  if (!active) return
  let item = stats.get(key)
  if (!item) stats.set(key, item = { count: 0, totalMs: 0, maxMs: 0 })
  const ms = performance.now() - start
  const request = requests.getStore()
  if (request?.measured) request.dependencyMs += ms
  item.count++
  item.totalMs += ms
  item.maxMs = Math.max(item.maxMs, ms)
}
const query = pg.Client.prototype.query
pg.Client.prototype.query = function (...args) {
  const start = performance.now()
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? ''
  const key = `pg:${sql.replace(/\s+/g, ' ').trim().slice(0, 180)}`
  const last = args.length - 1
  if (typeof args[last] === 'function') {
    const cb = args[last]
    args[last] = (...results) => { record(key, start); cb(...results) }
    return query.apply(this, args)
  }
  const result = query.apply(this, args)
  return result?.then ? result.finally(() => record(key, start)) : result
}
const connect = pg.Pool.prototype.connect
pg.Pool.prototype.connect = function (cb) {
  const start = performance.now()
  if (cb) return connect.call(this, (...args) => { record('pool:acquire', start); cb(...args) })
  return connect.call(this).finally(() => record('pool:acquire', start))
}
const send = Redis.prototype.sendCommand
Redis.prototype.sendCommand = function (command, ...args) {
  const start = performance.now()
  const result = send.call(this, command, ...args)
  // Do not charge the relay's intentionally blocking XREADGROUP to request Redis overhead.
  if (command.name === 'xreadgroup') return result
  return result.finally(() => record(`redis:${command.name}`, start))
}
const sampler = setInterval(() => {
  if (!active) return
  const mem = process.memoryUsage()
  peakRss = Math.max(peakRss, mem.rss)
  peakHeap = Math.max(peakHeap, mem.heapUsed)
}, 50)
sampler.unref()
const out = resolve(process.env.PERF_OUTPUT_DIR ?? '/tmp/caracal-coordinator-perf/profiles')
await mkdir(out, { recursive: true })
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    if (req.url === '/start' && !active) {
      stats = new Map()
      requestTotals = { count: 0, wallMs: 0, dependencyMs: 0, residualMs: 0 }
      peakRss = process.memoryUsage().rss
      peakHeap = process.memoryUsage().heapUsed
      loop.reset()
      if (sampling) {
        await inspector.post('Profiler.enable')
        await inspector.post('Profiler.start')
        await inspector.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
      }
      cpu = process.cpuUsage()
      started = performance.now()
      active = true
      res.end('{}')
    } else if (req.url?.startsWith('/stop?') && active) {
      const elapsedMs = performance.now() - started
      const usage = process.cpuUsage(cpu)
      active = false
      const cpuProfile = sampling ? (await inspector.post('Profiler.stop')).profile : null
      const heapProfile = sampling ? (await inspector.post('HeapProfiler.stopSampling')).profile : null
      const label = new URL(req.url, 'http://localhost').searchParams.get('label')
      if (!label || !/^[a-z0-9_.-]+$/i.test(label)) throw new Error('invalid label')
      if (sampling) {
        await writeFile(`${out}/${label}.cpuprofile`, JSON.stringify(cpuProfile))
        await writeFile(`${out}/${label}.heapprofile`, JSON.stringify(heapProfile))
      }
      const result = {
        elapsedMs, cpuMs: (usage.user + usage.system) / 1000,
        cpuPercent: (usage.user + usage.system) / (elapsedMs * 10),
        peakRssBytes: peakRss, peakHeapBytes: peakHeap,
        sampling, sampledAllocatedBytes: heapProfile ? heapProfile.samples.reduce((sum, sample) => sum + sample.size, 0) : null,
        eventLoopP99Ms: loop.percentile(99) / 1e6,
        requestTotals, dependencies: Object.fromEntries(stats),
      }
      await writeFile(`${out}/${label}.json`, JSON.stringify(result, null, 2))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result))
    } else { res.writeHead(409).end('{}') }
  } catch (err) { res.writeHead(500).end(JSON.stringify({ error: String(err) })) }
})
await new Promise((done) => server.listen(Number(process.env.PERF_PROFILE_PORT ?? 14001), '127.0.0.1', done))
server.unref()
