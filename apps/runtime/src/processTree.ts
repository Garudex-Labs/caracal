// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single OS boundary for spawning and terminating killable process trees across every supported platform.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const isWindows = process.platform === 'win32'
// pnpm ships as a bare binary on POSIX; on Windows it is pnpm.exe (standalone install)
// or a pnpm.cmd shim (npm/corepack), probed in PATHEXT order.
const PNPM_BINS = isWindows ? ['pnpm.exe', 'pnpm.cmd'] : ['pnpm']

// Windows refuses to spawn .cmd/.bat shims without a shell (Node's CVE-2024-27980 fix),
// so those launches must opt into the platform shell. Every other executable runs
// directly. This is the only place the distinction is made.
function shellFor(command: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(command)
}

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
// spawnSyncTree apply the shell opt-in for it.
export function resolvePnpm(): PnpmInvocation | undefined {
  const execpath = process.env.npm_execpath
  if (execpath && /pnpm/i.test(execpath)) return { cmd: process.execPath, prefix: [execpath] }
  const onPath = locate(PNPM_BINS)
  if (onPath) return { cmd: onPath, prefix: [] }
  return undefined
}

// Spawn a child as a process tree that can later be torn down whole. On POSIX the child
// leads its own process group (detached) so a single negative-PID signal reaches every
// descendant; on Windows there are no POSIX groups, so the child stays attached and is
// reaped later with taskkill /T. Callers never set detached/shell/windowsHide themselves.
export function spawnTree(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, {
    ...options,
    detached: !isWindows,
    shell: shellFor(command),
    windowsHide: true,
  })
}

// Synchronous spawn for one-shot child commands (e.g. builds), applying the same Windows
// shell opt-in so .cmd shims do not throw EINVAL.
export function spawnSyncTree(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
): SpawnSyncReturns<string | Buffer> {
  return spawnSync(command, args, { ...options, shell: shellFor(command), windowsHide: true })
}

// Terminate a child and every descendant it spawned, portably. POSIX signals the child's
// whole process group via its negative PID; Windows walks and kills the tree with taskkill.
// SIGKILL maps to a forced kill (taskkill /F); any other signal is a best-effort graceful
// stop. Falls back to a direct child kill if the tree teardown is unavailable.
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (isWindows) {
    const args = ['/pid', String(pid), '/T']
    if (signal === 'SIGKILL') args.push('/F')
    try {
      spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true })
      return
    } catch {
      /* fall through to a direct kill */
    }
  } else {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      /* fall through to a direct kill */
    }
  }
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
