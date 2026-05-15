// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for `caracal run` and the safe child-process spawn helper.

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { createInterface } from 'node:readline'

const SIGNAL_EXIT_MAP: Record<string, number> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9,
  SIGHUP: 1,
  SIGQUIT: 3,
}

export interface RunExecOpts {
  argv: string[]
  env?: Record<string, string | undefined>
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  cwd?: string
  forwardSignals?: boolean
}

export interface RunExecHandle {
  child: ChildProcess
  dispose: () => void
  exitCode: Promise<number>
}

function validateArgv(argv: string[]): void {
  if (argv.length === 0) throw new Error('runExec: argv is empty')
  for (const tok of argv) {
    if (typeof tok !== 'string') throw new Error('runExec: non-string argv token')
    if (tok.indexOf('\u0000') !== -1) throw new Error('runExec: argv token contains NUL byte')
  }
}

function buildChildEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  // Always derive from a copy of process.env; never mutate the caller's env.
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
  }
  return env
}

function exitFromSignal(signal: NodeJS.Signals | null): number {
  if (!signal) return 1
  return 128 + (SIGNAL_EXIT_MAP[signal] ?? 15)
}

export function runExec(opts: RunExecOpts): RunExecHandle {
  validateArgv(opts.argv)
  const [cmd, ...args] = opts.argv
  const env = buildChildEnv(opts.env)

  const stdio: StdioOptions = opts.onLine ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  // shell:true is forbidden — argv tokens are passed verbatim to the OS.
  const child = spawn(cmd!, args, { env, stdio, cwd: opts.cwd })

  if (opts.onLine) {
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => opts.onLine!(line, 'stdout'))
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr })
      rl.on('line', (line) => opts.onLine!(line, 'stderr'))
    }
  }

  let signalHandlers: ReadonlyArray<readonly [NodeJS.Signals, (...args: unknown[]) => void]> = []
  if (opts.forwardSignals !== false) {
    const forward: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']
    signalHandlers = forward.map((sig) => {
      const h = (): void => {
        try { child.kill(sig) } catch { /* already exited */ }
      }
      process.on(sig, h)
      return [sig, h] as const
    })
  }

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const [sig, h] of signalHandlers) process.off(sig, h)
    try { child.kill('SIGTERM') } catch { /* already exited */ }
  }

  const exitCode = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const [sig, h] of signalHandlers) process.off(sig, h)
      if (typeof code === 'number') return resolve(code)
      resolve(exitFromSignal(signal))
    })
    child.on('error', () => {
      for (const [sig, h] of signalHandlers) process.off(sig, h)
      resolve(127)
    })
  })

  return { child, dispose, exitCode }
}
