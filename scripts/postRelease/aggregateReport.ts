// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Aggregates JSONL validation findings and the release manifest into a docs release record.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

type Finding = {
  area: string
  artifact: string
  platform: string
  pm: string
  runtime: string
  severity: 'blocker' | 'major' | 'minor' | 'info'
  status: 'pass' | 'warn' | 'fail'
  evidence: string
  repro: string
}

type Manifest = {
  release: string
  mode?: 'rc' | 'stable'
  sha?: string
  publishedAt?: string
  generatedAt?: string
  registry?: string
  imagePrefix?: string
  binaries: Record<string, string>
  containers: Record<string, string>
  images?: Record<string, string>
  helm?: { chartVersion?: string }
  pypi?: Record<string, string>
  npm?: Record<string, string>
  packages?: {
    published?: {
      pypi?: Record<string, string>
      npm?: Record<string, string>
    }
  }
}

const release = process.env.CARACAL_RELEASE
const findingsDir = process.env.FINDINGS_DIR
if (!release || !findingsDir) {
  console.error('CARACAL_RELEASE and FINDINGS_DIR required')
  process.exit(2)
}
if (!/^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?(-rc\.(sha[0-9A-Za-z]+|[0-9]+))?$/.test(release)) {
  console.error(`invalid release tag: ${release}`)
  process.exit(2)
}
const repoRoot = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd())
const manifestPath = resolve(process.env.MANIFEST ?? join(repoRoot, 'releases', release, 'manifest.json'))
const recordDir = join(repoRoot, 'docs', 'src', 'data', 'releases')
const recordPath = join(recordDir, `${release}.json`)

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.release !== release) {
  console.error(`manifest release ${manifest.release} does not match ${release}`)
  process.exit(2)
}
const registry = manifest.registry ?? 'ghcr.io/garudex-labs'
const imagePrefix = manifest.imagePrefix ?? 'caracal-'
const publishedNpm = manifest.packages?.published?.npm ?? manifest.npm ?? {}
const publishedPypi = manifest.packages?.published?.pypi ?? manifest.pypi ?? {}

const AREAS = [
  ['registryMetadata', 'Registry Metadata'],
  ['pypiInstall', 'PyPI Install Matrix'],
  ['npmInstall', 'npm Install Matrix'],
  ['runtimeBinaries', 'Runtime CLI Binaries'],
  ['consoleBinaries', 'Console Binaries'],
  ['installers', 'Installers'],
  ['containers', 'Container Stack'],
  ['provenance', 'Provenance & Signing'],
] as const

const collectFindingFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return collectFindingFiles(path)
    return entry.endsWith('.jsonl') ? [path] : []
  })

const findings: Finding[] = []
if (existsSync(findingsDir)) {
  for (const f of collectFindingFiles(findingsDir)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      findings.push(JSON.parse(line))
    }
  }
}

const areas = AREAS.flatMap(([id, label]) => {
  const rows = findings.filter((r) => r.area === id)
  if (rows.length === 0) return []
  return [
    {
      id,
      label,
      pass: rows.filter((r) => r.status === 'pass').length,
      warn: rows.filter((r) => r.status === 'warn').length,
      fail: rows.filter((r) => r.status === 'fail').length,
    },
  ]
})
const pass = areas.reduce((n, a) => n + a.pass, 0)
const warn = areas.reduce((n, a) => n + a.warn, 0)
const fail = areas.reduce((n, a) => n + a.fail, 0)
const blockers = findings.filter((r) => r.severity === 'blocker' && r.status === 'fail').length
const total = pass + warn + fail
const score = total === 0 ? 0 : Math.round((pass / total) * 100)
const severityOrder = { blocker: 0, major: 1, minor: 2, info: 3 }
const notes = findings
  .filter((r) => r.status !== 'pass')
  .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
  .slice(0, 10)
  .map((r) => `[${r.severity}] ${r.status.toUpperCase()} ${r.artifact} (${r.platform}/${r.pm}): ${r.evidence.slice(0, 300)}`)

const validation = total === 0 ? null : { score, pass, warn, fail, blockers, areas, notes }

const images =
  manifest.images ??
  Object.fromEntries(Object.entries(manifest.containers).map(([svc, ver]) => [svc, `${registry}/${imagePrefix}${svc}:v${ver}`]))

async function releaseAssets(): Promise<string[]> {
  const url = `https://api.github.com/repos/Garudex-Labs/caracal/releases/tags/${release}`
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const body = (await res.json()) as { assets?: { name: string }[] }
    return (body.assets ?? []).map((a) => a.name).sort()
  } catch (err) {
    console.error(`release assets unavailable for ${release}: ${err}`)
    return []
  }
}

const record = {
  release,
  channel: manifest.mode ?? (release.includes('-rc.') ? 'rc' : 'stable'),
  date: manifest.publishedAt ?? manifest.generatedAt?.slice(0, 10) ?? release.replace(/^v(\d{4})\.(\d{2})\.(\d{2}).*$/, '$1-$2-$3'),
  sha: manifest.sha ?? null,
  binaries: manifest.binaries,
  images,
  npm: publishedNpm,
  pypi: publishedPypi,
  helm: manifest.helm?.chartVersion ?? null,
  assets: await releaseAssets(),
  validation,
}

mkdirSync(recordDir, { recursive: true })
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
console.log(`wrote ${recordPath} (${findings.length} findings, score ${score}%)`)
process.exit(fail > 0 ? 1 : 0)
