// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single OS boundary for spawning and terminating killable process trees across every supported platform.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
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

// First executable file named one of `names` in a PATH-style directory list, found without a shell.
export function findExecutable(names: string[], searchPath: string | undefined): string | undefined {
  for (const dir of (searchPath ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = resolve(dir, name)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK)
          return candidate
        }
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

function signalAll(targets: Iterable<number>, signal: NodeJS.Signals): void {
  for (const target of targets) {
    try {
      process.kill(target, signal)
    } catch {
      /* already gone */
    }
  }
}

interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  tty: string
  elapsedSeconds: number
}

// ps prints elapsed time as [[dd-]hh:]mm:ss on every POSIX platform.
function elapsedSeconds(value: string): number {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value]
  return (clock ?? '').split(':').reduce((total, part) => total * 60 + Number(part), Number(days) * 24 * 60)
}

function processTable(): ProcessRow[] {
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,tty=,etime='], { encoding: 'utf8', windowsHide: true }).stdout
  return (typeof table === 'string' ? table : '').split('\n').flatMap((line) => {
    const [pid, ppid, pgid, tty, etime] = line.trim().split(/\s+/)
    if (!pid || !ppid || !pgid || !tty || !etime) return []
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), tty, elapsedSeconds: elapsedSeconds(etime) }]
  })
}

// The processes of a child that shares the caller's terminal, and so the caller's process group:
// its descendants, plus any it left behind. A process whose parent exited is reparented out of the
// tree but stays in the group, so it is found there by having started after this process with a
// parent outside the group. The launcher's own ancestors and whatever they started, such as the
// other side of a pipeline, are spared; the ancestor just outside the group counts only when it sits
// on a terminal, because otherwise it is a reaper that adopts the very processes being looked for.
// A process that moved to its own group cannot be found.
function terminalTree(root: number): number[] {
  const rows = processTable()
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const children = new Map<number, number[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid])
  const group = byPid.get(process.pid)?.pgid
  const spared = new Set<number>([process.pid])
  for (let row = byPid.get(process.pid); row; row = byPid.get(row.ppid)) {
    if (row.pgid === group || !row.tty.startsWith('?')) spared.add(row.pid)
    if (row.pgid !== group) break
  }
  const leftBehind = rows.filter(
    (row) =>
      row.pgid === group &&
      !spared.has(row.pid) &&
      !spared.has(row.ppid) &&
      byPid.get(row.ppid)?.pgid !== group &&
      row.elapsedSeconds <= Math.floor(process.uptime()),
  )
  const tree = [root, ...leftBehind.map((row) => row.pid)]
  for (const pid of tree) tree.push(...(children.get(pid) ?? []))
  return [...new Set(tree)]
}

// Pass a signal the launcher received on to its child's tree. A child leading its own group gets
// it through the group. SIGINT and SIGQUIT go to the child alone otherwise, because the terminal
// already sent those keystrokes to the whole foreground group.
export function forwardSignal(child: ChildProcess, signal: NodeJS.Signals, leadsGroup: boolean): void {
  const pid = child.pid
  if (pid === undefined || isWindows || leadsGroup || signal === 'SIGINT' || signal === 'SIGQUIT') return killTree(child, signal)
  signalAll(terminalTree(pid), signal)
}

async function poll(running: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS))
}

// Stop a child's tree and resolve once it is gone: SIGTERM now, SIGKILL for anything still running
// after graceMs. A child on the caller's terminal keeps the terminal, so its tree is read from the
// process table and read again while it stops, which also catches what it starts in the meantime.
// Windows forces the stop at once: taskkill /T only finds descendants while the root is alive, and
// its graceful form does nothing for a console process.
export async function stopTree(child: ChildProcess, graceMs: number, leadsGroup: boolean): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (isWindows) {
    killTree(child, 'SIGKILL')
    return poll(() => child.exitCode === null && child.signalCode === null, STOP_KILL_SETTLE_MS)
  }
  if (leadsGroup) {
    killTree(child, 'SIGTERM')
    await poll(() => targetAlive(-pid), graceMs)
    if (!targetAlive(-pid)) return
    killTree(child, 'SIGKILL')
    return poll(() => targetAlive(-pid), STOP_KILL_SETTLE_MS)
  }
  const members = new Set<number>()
  const running = (): boolean => {
    const found = terminalTree(pid).filter((member) => !members.has(member))
    signalAll(found, 'SIGTERM')
    for (const member of found) members.add(member)
    return [...members].some(targetAlive)
  }
  await poll(running, graceMs)
  if (!running()) return
  signalAll(members, 'SIGKILL')
  await poll(() => [...members].some(targetAlive), STOP_KILL_SETTLE_MS)
}
