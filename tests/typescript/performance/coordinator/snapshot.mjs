// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Freeze compiled code and dependency resolution, so concurrent workspace builds cannot skew A/B runs.
import { cp, mkdir, readFile, writeFile, symlink, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const out = resolve(process.argv[2])
const baselineRef = process.argv[3] === '--baseline-ref' ? process.argv[4] : null
const appDist = resolve(baselineRef ? 'apps/coordinator/dist' : process.argv[3] ?? 'apps/coordinator/dist')
const auditDist = resolve(baselineRef ? 'packages/adminAudit/ts/dist' : process.argv[4] ?? 'packages/adminAudit/ts/dist')
const packages = { core: 'core/ts', 'server-core': 'serverCore/ts', 'admin-audit': 'adminAudit/ts', identity: 'identity/ts' }
await mkdir(out, { recursive: true })
const moduleDirs = { coordinator: resolve('apps/coordinator'), ...Object.fromEntries(Object.entries(packages).map(([name, path]) => [name, resolve('packages', path)])) }
const manifest = {}
for (const [name, source] of Object.entries(moduleDirs)) {
  const target = join(out, name)
  await mkdir(target, { recursive: true })
  const dist = name === 'coordinator' ? appDist : name === 'admin-audit' ? auditDist : join(source, 'dist')
  await cp(dist, join(target, 'dist'), { recursive: true })
  if (baselineRef && (name === 'coordinator' || name === 'admin-audit')) {
    // Isolate these two optimized modules; all surrounding code and installed dependencies remain identical.
    const file = name === 'coordinator' ? 'apps/coordinator/src/idempotency.ts' : 'packages/adminAudit/ts/src/index.ts'
    const original = execFileSync('git', ['show', `${baselineRef}:${file}`], { encoding: 'utf8' })
    const ts = createRequire(resolve('package.json'))('typescript')
    const code = ts.transpileModule(original, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText
    await writeFile(join(target, 'dist', name === 'coordinator' ? 'idempotency.js' : 'index.js'), code)
    manifest.baselineRef = baselineRef
  }
  await cp(join(source, 'package.json'), join(target, 'package.json'))
  const config = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await mkdir(join(target, 'node_modules/@caracalai'), { recursive: true })
  for (const dependency of Object.keys(config.dependencies ?? {})) {
    const dest = dependency.startsWith('@caracalai/') ? join(out, dependency.slice('@caracalai/'.length)) : await realpath(resolve(source, 'node_modules', dependency))
    if (!dependency.startsWith('@caracalai/')) {
      const pkg = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'))
      manifest[dependency] = pkg.version
      if (dependency.startsWith('@')) await mkdir(join(target, 'node_modules', dependency.split('/')[0]), { recursive: true })
    }
    await symlink(dest, join(target, 'node_modules', dependency))
  }
  // Hash every frozen module to identify the measured artifacts without secrets.
  const { readdir } = await import('node:fs/promises')
  async function hashDir(path, relative = '') {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name), key = join(relative, item.name)
      if (item.isDirectory()) await hashDir(file, key)
      else manifest[`${name}/${key}`] = createHash('sha256').update(await readFile(file)).digest('hex')
    }
  }
  await hashDir(join(target, 'dist'))
}
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(join(out, 'coordinator/dist/main.js'))
