// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Alternate frozen A/B artifacts with exactly the same real-stack workload and profiler settings.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const before = resolve(process.argv[2]), after = resolve(process.argv[3])
const out = resolve(process.env.PERF_OUTPUT_DIR ?? '/tmp/caracal-coordinator-bench/profiles')
await mkdir(out, { recursive: true })
if (process.env.PERF_ALLOW_DIFFERENT_SURROUNDING_CODE !== '1') {
  const beforeManifest = JSON.parse(await readFile(`${before}/manifest.json`, 'utf8'))
  const afterManifest = JSON.parse(await readFile(`${after}/manifest.json`, 'utf8'))
  const allowed = new Set(['coordinator/idempotency.js', 'admin-audit/index.js', 'baselineRef'])
  for (const key of new Set([...Object.keys(beforeManifest), ...Object.keys(afterManifest)])) {
    if (!allowed.has(key)) assert.equal(afterManifest[key], beforeManifest[key], `Non-performance artifact differs: ${key}`)
  }
}
async function runChild(args, env, log) {
  const file = await open(log, 'w')
  const child = spawn('taskset', args, { env, stdio: ['ignore', file.fd, file.fd] })
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  return { child, exited, file }
}
for (let pass = 1; pass <= Number(process.env.PERF_REPEATS ?? 2); pass++) {
  for (const [variant, root] of [['before', before], ['after', after]]) {
    const label = `${variant}-${process.env.PERF_RUN_ID ?? 'warm'}-${pass}`
    const server = await runChild(['-c', process.env.PERF_CPU ?? '14', process.execPath, '--import', resolve('tests/typescript/performance/coordinator/profile.mjs'), `${root}/coordinator/dist/main.js`], {
      ...process.env, PORT: '4000', PERF_MODULE_ROOT: `${root}/coordinator/package.json`, PERF_OUTPUT_DIR: out,
    }, `${out}/${label}-server.log`)
    try {
      let ready = false
      for (let attempt = 0; attempt < 300; attempt++) {
        if (server.child.exitCode !== null) throw new Error(`Coordinator startup failed; see ${out}/${label}-server.log`)
        try { ready = (await fetch('http://127.0.0.1:4000/health', { signal: AbortSignal.timeout(500) })).ok } catch { /* Wait for this exact child to listen. */ }
        if (ready) break
        await new Promise((done) => setTimeout(done, 50))
      }
      assert.ok(ready, 'Coordinator did not become healthy')
      const load = await runChild(['-c', process.env.PERF_LOAD_CPU ?? '15', process.execPath, resolve('tests/typescript/performance/coordinator/workload.mjs')], { ...process.env, PERF_OUTPUT_DIR: out, PERF_LABEL: label }, `${out}/${label}-load.log`)
      const result = await load.exited
      await load.file.close()
      assert.equal(result.code, 0, `Workload failed; see ${out}/${label}-load.log`)
      console.log(`Completed ${label}`)
    } finally {
      server.child.kill('SIGTERM')
      const timer = setTimeout(() => server.child.kill('SIGKILL'), 30_000)
      await server.exited
      clearTimeout(timer)
      await server.file.close()
    }
  }
}
