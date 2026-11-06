// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shim-free resolution of the pnpm invocation used by workspace interface launchers.

import { existsSync } from 'node:fs'
import { findExecutable } from '@caracalai/engine'

// pnpm ships as a bare binary on POSIX; on Windows it is pnpm.exe (standalone install)
// or a pnpm.cmd shim (npm/corepack), probed in that fixed order.
const PNPM_BINS = process.platform === 'win32' ? ['pnpm.exe', 'pnpm.cmd'] : ['pnpm']
const PNPM_ENTRY = /(^|[\\/])pnpm(\.[cm]?js|\.exe|\.cmd)?$/i
const JS_ENTRY = /\.[cm]?js$/i

export interface PnpmInvocation {
  cmd: string
  prefix: string[]
}

// Resolve a pnpm invocation without going through a shell where possible: prefer running
// the pnpm CLI module with the current Node binary (portable and shim-free), otherwise the
// pnpm executable on PATH. The PATH fallback may be a Windows .cmd shim; spawnTree and
// spawnSyncTree from @caracalai/engine apply the shell opt-in for it.
export function resolvePnpm(): PnpmInvocation | undefined {
  const execpath = process.env.npm_execpath
  if (execpath && PNPM_ENTRY.test(execpath) && existsSync(execpath)) {
    if (!JS_ENTRY.test(execpath)) return { cmd: execpath, prefix: [] }
    // In a compiled caracal binary process.execPath is caracal itself, which cannot run a script.
    if (!process.versions.bun) return { cmd: process.execPath, prefix: [execpath] }
  }
  const onPath = findExecutable(PNPM_BINS, process.env.PATH)
  if (onPath) return { cmd: onPath, prefix: [] }
  return undefined
}
