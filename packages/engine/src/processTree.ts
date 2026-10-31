// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single OS boundary for spawning and terminating killable process trees across every supported platform.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { isatty } from 'node:tty'

const isWindows = process.platform === 'win32'

// Windows refuses to spawn .cmd/.bat shims without a shell (Node's CVE-2024-27980 fix),
// so those launches must opt into the platform shell. Every other executable runs
// directly. This is the only place the distinction is made.
function shellFor(command: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(command)
}

// First file named one of `names` in a PATH-style directory list, found without a shell.
export function findExecutable(names: string[], searchPath: string | undefined): string | undefined {
  for (const dir of (searchPath ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
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

// Whether a POSIX child should lead its own process group so killTree reaches every
// descendant. Node's `detached` also starts a new session without a controlling terminal,
// which breaks /dev/tty for a child attached to the caller's terminal; such a child stays
// in the foreground group, where terminal signals already reach its whole tree. Windows
// has no POSIX groups and is always reaped with taskkill /T.
export function leadsProcessGroup(stdio: SpawnOptions['stdio']): boolean {
  if (isWindows) return false
  const slots = Array.isArray(stdio) ? stdio.slice(0, 3) : [stdio, stdio, stdio]
  return !slots.some((slot, fd) => slot === 'inherit' && isatty(fd))
}

// Spawn a child as a process tree that can later be torn down whole. Callers never set
// detached/shell/windowsHide themselves.
export function spawnTree(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, {
    ...options,
    detached: leadsProcessGroup(options.stdio),
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
// stop. Falls back to a direct child kill if the tree teardown is unavailable, including a
// POSIX child that does not lead its own group.
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
