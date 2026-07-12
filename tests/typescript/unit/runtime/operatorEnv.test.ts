// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the centralized operator env loader shared by all caracal commands.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadOperatorEnv } from '../../../../packages/engine/src/operatorEnv.ts'

const TOUCHED = ['CARACAL_HOME', 'CARACAL_ENV_FILE', 'CARACAL_MODE', 'CARACAL_REPO_ROOT', 'NODE_ENV', 'WL_ID', 'WL_URL']

describe('loadOperatorEnv', () => {
  let home: string
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'caracal-operator-env-'))
    saved = {}
    for (const key of TOUCHED) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.CARACAL_HOME = home
  })

  afterEach(() => {
    for (const key of TOUCHED) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('loads the installed caracal.env into process.env', () => {
    writeFileSync(join(home, 'caracal.env'), 'WL_ID=fiona\nWL_URL=https://sts.pipernet.example\n')

    const applied = loadOperatorEnv()

    expect(applied).toEqual([join(home, 'caracal.env')])
    expect(process.env.WL_ID).toBe('fiona')
    expect(process.env.WL_URL).toBe('https://sts.pipernet.example')
  })

  it('never overrides a variable already present in the environment', () => {
    process.env.WL_ID = 'from-shell'
    writeFileSync(join(home, 'caracal.env'), 'WL_ID=from-file\n')

    loadOperatorEnv()

    expect(process.env.WL_ID).toBe('from-shell')
  })

  it('applies an explicit CARACAL_ENV_FILE', () => {
    const explicit = join(home, 'custom.env')
    writeFileSync(explicit, 'WL_ID=explicit\n')
    process.env.CARACAL_ENV_FILE = explicit

    const applied = loadOperatorEnv()

    expect(applied).toContain(explicit)
    expect(process.env.WL_ID).toBe('explicit')
  })

  it('is a no-op when no operator env file exists', () => {
    expect(loadOperatorEnv()).toEqual([])
    expect(process.env.WL_ID).toBeUndefined()
  })

  it('loads the repo stack files in dev mode', () => {
    const repo = mkdtempSync(join(tmpdir(), 'caracal-operator-repo-'))
    try {
      mkdirSync(join(repo, 'infra', 'docker'), { recursive: true })
      writeFileSync(join(repo, 'infra', 'docker', 'local.env'), 'WL_ID=dev-local\n')
      process.env.CARACAL_MODE = 'dev'
      process.env.CARACAL_REPO_ROOT = repo

      const applied = loadOperatorEnv()

      expect(applied).toContain(join(repo, 'infra', 'docker', 'local.env'))
      expect(process.env.WL_ID).toBe('dev-local')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('treats a set CARACAL_REPO_ROOT as dev even when CARACAL_MODE is unset', () => {
    const repo = mkdtempSync(join(tmpdir(), 'caracal-operator-repo-'))
    try {
      mkdirSync(join(repo, 'infra', 'docker'), { recursive: true })
      writeFileSync(join(repo, 'infra', 'docker', 'local.env'), 'WL_ID=repo-implied\n')
      process.env.CARACAL_REPO_ROOT = repo // the workspace launcher sets this, not CARACAL_MODE

      loadOperatorEnv()

      expect(process.env.WL_ID).toBe('repo-implied')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('prefers the repo-root .env over the nested stack files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'caracal-operator-repo-'))
    try {
      mkdirSync(join(repo, 'infra', 'docker'), { recursive: true })
      writeFileSync(join(repo, '.env'), 'WL_ID=root\n')
      writeFileSync(join(repo, 'infra', 'docker', 'local.env'), 'WL_ID=nested\n')
      process.env.CARACAL_REPO_ROOT = repo

      const applied = loadOperatorEnv()

      expect(applied[0]).toBe(join(repo, '.env'))
      expect(process.env.WL_ID).toBe('root')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
