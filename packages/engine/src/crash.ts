// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared process-level crash handler: redacted single-line diagnostics with optional non-fatal mode for interactive hosts.

const TOKEN_PATTERNS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9._-]+/g,
  /caracal_at_[A-Za-z0-9._-]+/g,
  /caracal_rt_[A-Za-z0-9._-]+/g,
  /Bearer [^\s]+/g,
]

export function scrubTokens(s: string): string {
  let out = s
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '***')
  return out
}

export interface CrashHandlerOptions {
  readonly onError?: (line: string) => void
  readonly exitOnError?: boolean
}

interface Listeners {
  unc: (err: unknown) => void
  unh: (reason: unknown) => void
}

let installed: Listeners | null = null

export function installCrashHandlers(label: string, opts: CrashHandlerOptions = {}): void {
  if (installed) return
  const exitOnError = opts.exitOnError !== false
  const emit = (msg: string): void => {
    const line = scrubTokens(`${label}: ${msg}`)
    if (opts.onError) opts.onError(line)
    else process.stderr.write(line + '\n')
  }
  const unc = (err: unknown): void => {
    emit(err instanceof Error ? err.message : String(err))
    if (exitOnError) process.exit(1)
  }
  const unh = (reason: unknown): void => {
    emit(reason instanceof Error ? reason.message : String(reason))
    if (exitOnError) process.exit(1)
  }
  process.on('uncaughtException', unc)
  process.on('unhandledRejection', unh)
  installed = { unc, unh }
}

export function disposeCrashHandlers(): void {
  if (!installed) return
  process.off('uncaughtException', installed.unc)
  process.off('unhandledRejection', installed.unh)
  installed = null
}
