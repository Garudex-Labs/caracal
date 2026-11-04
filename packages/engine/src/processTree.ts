// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single OS boundary for spawning and terminating killable process trees across every supported platform.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns } from 'node:child_process'
import { isatty } from 'node:tty'

const isWindows = process.platform === 'win32'
const STOP_POLL_MS = 50
const STOP_KILL_SETTLE_MS = 1_000

// Windows refuses to spawn .cmd/.bat shims without a shell (Node's CVE-2024-27980 fix),
// so those launches must opt into the platform shell. Every other executable runs
// directly. This is the only place the distinction is made.
function shellFor(command: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(command)
}

// Whether a POSIX child should lead its own process group so killTree reaches every
// descendant. Node's `detached` also starts a new session without a controlling terminal,
// which breaks /dev/tty for a child attached to the caller's terminal; such a child stays
// in the foreground group, where terminal signals already reach its whole tree. Windows
// has no POSIX groups and is always reaped with taskkill /T. A stdio slot shares a parent
// descriptor when it is 'inherit', a descriptor number, or a stream backed by a descriptor.
export function leadsProcessGroup(stdio: SpawnOptions['stdio']): boolean {
  if (isWindows) return false
  const slots = Array.isArray(stdio) ? stdio.slice(0, 3) : [stdio, stdio, stdio]
  return !slots.some((slot, index) => {
    const fd = slot === 'inherit' ? index : typeof slot === 'number' ? slot : (slot as { fd?: unknown } | null | undefined)?.fd
    return typeof fd === 'number' && isatty(fd)
  })
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
      if (spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true }).status === 0) return
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

function targetAlive(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch {
    return false
  }
}

// A process and its current descendants, read from the process table.
function descendantsOf(root: number): number[] {
  const children = new Map<number, number[]>()
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true }).stdout
  for (const line of (typeof table === 'string' ? table : '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid && ppid !== undefined) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const tree = [root]
  for (const pid of tree) tree.push(...(children.get(pid) ?? []))
  return tree
}

// Stop a child's tree and resolve once it is gone: SIGTERM now, SIGKILL for anything still
// running after graceMs. A POSIX child sharing the caller's terminal leads no group, so its
// tree is snapshotted from the process table while it runs; that keeps it on the terminal,
// and only a process that already detached from the tree can outlive the stop.
export async function stopTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  const members = !isWindows && !targetAlive(-pid) ? descendantsOf(pid) : undefined
  const send = (signal: NodeJS.Signals): void => {
    if (!members) return killTree(child, signal)
    for (const member of members) {
      try {
        process.kill(member, signal)
      } catch {
        /* already gone */
      }
    }
  }
  const running = (): boolean => {
    if (members) return members.some(targetAlive)
    return isWindows ? child.exitCode === null && child.signalCode === null : targetAlive(-pid)
  }
  const settle = async (ms: number): Promise<void> => {
    const deadline = Date.now() + ms
    while (running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS))
  }
  send('SIGTERM')
  await settle(graceMs)
  if (!running()) return
  send('SIGKILL')
  await settle(STOP_KILL_SETTLE_MS)
}
