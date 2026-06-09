// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the standalone Console installer script contract.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..', '..', '..', '..')
const installer = join(root, 'install-console.sh')

describe('install-console.sh', () => {
  it('documents POSIX install roots and uninstall mode', () => {
    const help = execFileSync('sh', [installer, '--help'], { cwd: root, encoding: 'utf8' })

    expect(help).toContain('--prefix PATH')
    expect(help).toContain('--destdir PATH')
    expect(help).toContain('--uninstall')
    expect(help).toContain('DESTDIR')
  })

  it('removes installed binaries without contacting release services', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-install-'))
    const runtime = join(dir, 'caracal')
    const console = join(dir, 'caracal-console')
    writeFileSync(runtime, '')
    writeFileSync(console, '')
    chmodSync(runtime, 0o755)
    chmodSync(console, 0o755)

    execFileSync('sh', [installer, '--install-dir', dir, '--uninstall'], { cwd: root, encoding: 'utf8' })

    expect(existsSync(runtime)).toBe(false)
    expect(existsSync(console)).toBe(false)
  })

  it('applies DESTDIR to POSIX uninstall paths', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'caracal-destdir-'))
    const installDir = '/usr/bin'
    const stagedDir = join(rootDir, 'usr/bin')
    const runtime = join(stagedDir, 'caracal')
    mkdirSync(stagedDir, { recursive: true })
    writeFileSync(runtime, '', { mode: 0o755 })

    execFileSync('sh', [installer, '--install-dir', installDir, '--uninstall'], {
      cwd: root,
      env: { ...process.env, DESTDIR: rootDir },
      encoding: 'utf8',
    })

    expect(existsSync(runtime)).toBe(false)
  })

  it('passes POSIX shell syntax validation', () => {
    execFileSync('sh', ['-n', installer], { cwd: root, stdio: 'pipe' })
  })
})
