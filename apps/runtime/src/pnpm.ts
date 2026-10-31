// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shim-free resolution of the pnpm invocation used by workspace interface launchers.

import { findExecutable } from '@caracalai/engine'

// pnpm ships as a bare binary on POSIX; on Windows it is pnpm.exe (standalone install)
// or a pnpm.cmd shim (npm/corepack), probed in PATHEXT order.
const PNPM_BINS = process.platform === 'win32' ? ['pnpm.exe', 'pnpm.cmd'] : ['pnpm']

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
  const onPath = findExecutable(PNPM_BINS, process.env.PATH)
  if (onPath) return { cmd: onPath, prefix: [] }
  return undefined
}
