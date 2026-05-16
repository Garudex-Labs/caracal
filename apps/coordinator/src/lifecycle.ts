// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Graceful shutdown registry: ordered teardown of resources on SIGTERM/SIGINT.

export type ShutdownFn = () => Promise<void> | void

interface Entry {
  name: string
  fn: ShutdownFn
}

export class ShutdownRegistry {
  private entries: Entry[] = []
  private installed = false
  private firing = false

  constructor(
    private readonly opts: {
      timeoutMs: number
      log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
      exit?: (code: number) => void
    },
  ) {}

  register(name: string, fn: ShutdownFn): void {
    this.entries.push({ name, fn })
  }

  get draining(): boolean {
    return this.firing
  }

  install(signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): void {
    if (this.installed) return
    this.installed = true
    for (const sig of signals) {
      process.once(sig, () => {
        void this.fire(sig)
      })
    }
  }

  async fire(reason: string): Promise<void> {
    if (this.firing) return
    this.firing = true
    this.opts.log('info', 'shutdown initiated', { reason, entries: this.entries.length })
    const exit = this.opts.exit ?? ((code) => process.exit(code))
    const deadline = Date.now() + this.opts.timeoutMs

    const timeout = setTimeout(() => {
      this.opts.log('error', 'shutdown timed out; forcing exit', { timeoutMs: this.opts.timeoutMs })
      exit(1)
    }, this.opts.timeoutMs)
    timeout.unref()

    let exitCode = 0
    for (const entry of [...this.entries].reverse()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        this.opts.log('error', 'shutdown deadline exceeded; skipping remaining', { skipped: entry.name })
        exitCode = 1
        break
      }
      try {
        await entry.fn()
        this.opts.log('info', 'shutdown step completed', { entry: entry.name })
      } catch (err) {
        this.opts.log('error', 'shutdown step failed', {
          entry: entry.name, err: (err as Error).message,
        })
        exitCode = 1
      }
    }
    clearTimeout(timeout)
    exit(exitCode)
  }
}
