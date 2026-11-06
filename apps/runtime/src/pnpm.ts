// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shim-free resolution of the pnpm invocation used by workspace interface launchers.

import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// pnpm ships as a bare binary on POSIX; on Windows it is pnpm.exe (standalone install)
// or a pnpm.cmd shim (npm/corepack), probed in PATHEXT order.
const PNPM_BINS = process.platform === 'win32' ? ['pnpm.exe', 'pnpm.cmd'] : ['pnpm']

function locate(binNames: string[]): string | undefined {
  const path = process.env.PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const name of binNames) {
      const candidate = join(dir, name)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        /* ignore */
      }
    }
  }
  return undefined
}

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
  if (execpath && /pnpm/i.test(execpath)) return { cmd: process.execPath, prefix: [execpath] }
  const onPath = locate(PNPM_BINS)
  if (onPath) return { cmd: onPath, prefix: [] }
  return undefined
}
