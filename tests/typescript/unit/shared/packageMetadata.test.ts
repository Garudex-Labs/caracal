// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Package metadata tests for deterministic internal dependency resolution.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

const pyProjects = [
  'packages/core/python',
  'packages/identity/python',
  'packages/revocation/python',
  'packages/sdk/python',
  'packages/verify/python',
  'packages/adapters/fastmcp/python',
  'packages/backends/redis/python',
]

function readPyProject(dir: string): { name: string; version: string; dependencies: string[] } {
  const text = readFileSync(join(repoRoot, dir, 'pyproject.toml'), 'utf8')
  const name = text.match(/^name = "([^"]+)"/m)?.[1]
  const version = text.match(/^version = "([^"]+)"/m)?.[1]
  if (!name || !version) throw new Error(`missing package name or version in ${dir}`)
  const depsBlock = text.match(/dependencies = \[(?<deps>[\s\S]*?)\]/m)?.groups?.deps ?? ''
  const inlineDeps = text.match(/dependencies = \[(?<deps>[^\n]*)\]/m)?.groups?.deps ?? ''
  const dependencies = [...depsBlock.matchAll(/"([^"]+)"/g), ...inlineDeps.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  return { name, version, dependencies }
}

describe('package metadata', () => {
  it('pins Python internal package dependencies to the published package version', () => {
    const versions = new Map(
      pyProjects.map((dir) => {
        const project = readPyProject(dir)
        return [project.name, project.version]
      }),
    )

    for (const dir of pyProjects) {
      for (const dep of readPyProject(dir).dependencies) {
        const depName = dep.match(/^(caracalai-[A-Za-z0-9-]+)/)?.[1]
        if (!depName || !versions.has(depName)) continue
        expect(dep, `${dir} dependency ${depName}`).toBe(`${depName}==${versions.get(depName)}`)
      }
    }
  })
})
