// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Optional interface launcher that runs the Caracal web console (UI) and its session-guarded backend-for-frontend together.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { scrubTokens } from '@caracalai/engine/crash'
import { printError, printInfo, printWarn, style } from '../style.ts'
import { devAuthDatabaseUrl, devAuthSecret } from './authStore.ts'

const EXT = process.platform === 'win32' ? '.exe' : ''
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const DEFAULT_WEB_PORT = 3001
const DEFAULT_AUTH_PORT = 3002
// The web console is a control-plane surface: its backend-for-frontend only proxies
// the local stack started by `caracal up`. Mirror the BFF's own service-URL defaults
// so the launcher gates on the same endpoints the running console will use.
const DEFAULT_API_URL = 'http://localhost:3000'
const DEFAULT_COORDINATOR_URL = 'http://localhost:4000'
const PREFLIGHT_TIMEOUT_MS = 2500

function apiUrl(): string {
  return (process.env.CARACAL_API_URL ?? DEFAULT_API_URL).replace(/\/$/, '')
}

function coordinatorUrl(): string {
  return (process.env.CARACAL_COORDINATOR_URL ?? DEFAULT_COORDINATOR_URL).replace(/\/$/, '')
}

// The auth backend runs on PostgreSQL in every environment. For a local `caracal web`
// session, point it at the dev stack's Postgres on localhost and provision its signing
// secret automatically, so the operator never configures a database or secret by hand.
// Explicit operator-provided values always win.
function authStoreEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (!process.env.CARACAL_AUTH_DATABASE_URL && !process.env.DATABASE_URL) {
    const url = devAuthDatabaseUrl()
    if (url) env.CARACAL_AUTH_DATABASE_URL = url
  }
  if (!process.env.CARACAL_AUTH_SECRET) env.CARACAL_AUTH_SECRET = devAuthSecret()
  return env
}

// Probe a service's public health endpoint. The admin API and Coordinator both expose
// an unauthenticated `/health`, so the launcher never needs an admin token to decide
// whether the stack is up. A single retry absorbs cold-connection false negatives so a
// transient blip never wrongly blocks launch.
async function serviceUp(base: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS)
    try {
      const res = await fetch(`${base}/health`, { signal: controller.signal })
      if (res.ok) return true
    } catch {
      /* retry once */
    } finally {
      clearTimeout(timer)
    }
  }
  return false
}

function repoRoot(): string | undefined {
  return process.env.CARACAL_REPO_ROOT
}

function workspaceDirExists(rel: string): boolean {
  const root = repoRoot()
  if (!root) return false
  const target = join(root, rel, 'package.json')
  try {
    return existsSync(target) && statSync(target).isFile()
  } catch {
    return false
  }
}

// The web console is a workspace-only interface today: it needs both the web UI
// and the auth/BFF packages present under the repo root. In a packaged runtime
// (no repo root) the launcher hides itself, mirroring the Console launcher rule.
export function webInterfaceAvailable(): boolean {
  return workspaceDirExists('apps/web') && workspaceDirExists('apps/auth')
}

function locate(binName: string): string | undefined {
  const path = process.env.PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, `${binName}${EXT}`)
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* ignore */
    }
  }
  return undefined
}

// Resolve a pnpm invocation without going through a shell: prefer the pnpm that
// launched this process, otherwise the one on PATH.
function pnpmInvocation(): { cmd: string; prefix: string[] } | undefined {
  const execpath = process.env.npm_execpath
  if (execpath && /pnpm/i.test(execpath)) return { cmd: process.execPath, prefix: [execpath] }
  const onPath = locate(PNPM_BIN)
  if (onPath) return { cmd: onPath, prefix: [] }
  return undefined
}

// The launcher aggregates two child servers (the web UI and the backend-for-frontend)
// into one terminal. Their raw output is noisy: the backend logs structured JSON and
// the UI logs free text, with no source attribution and no redaction. Every line is
// routed through this formatter so the operator sees a single, clean, source-tagged
// stream with secrets scrubbed and JSON logs rendered as readable fields.

// Base log fields that identify the process rather than the event. They are constant
// for the whole session, so repeating them on every line is pure noise.
const NOISE_FIELDS = new Set(['level', 'time', 'msg', 'service', 'hostname', 'pid', 'version', 'env', 'trace_id', 'span_id'])

// Redact bearer/JWT tokens (scrubTokens) and inline connection-string credentials
// (e.g. postgres://user:secret@host) before anything reaches the terminal.
function scrubLine(line: string): string {
  return scrubTokens(line).replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1***@')
}

function paintLevel(level: string, text: string): string {
  switch (level) {
    case 'warn':
      return style.warn(text)
    case 'error':
    case 'fatal':
      return style.error(text)
    case 'debug':
    case 'trace':
      return style.debug(text)
    default:
      return style.info(text)
  }
}

function paintTag(tag: string): string {
  return tag === 'web' ? style.accent(tag) : style.progress(tag)
}

function gutter(tag: string): string {
  return `${paintTag(tag)} ${style.dim('│')}`
}

function fmtValue(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

// Render one structured log record (the JSON our services emit) as a compact line:
// `HH:MM:SS LEVEL message  key=value …`, dropping process-identity noise. Returns null
// when the object is not one of our log records so the caller can fall back to verbatim.
function formatRecord(record: Record<string, unknown>): string | null {
  if (typeof record.msg !== 'string' || typeof record.level !== 'string') return null
  const level = record.level.toLowerCase()
  const badge = paintLevel(level, record.level.toUpperCase().padEnd(5))
  const time = typeof record.time === 'string' ? record.time.slice(11, 19) : ''
  const fields = Object.entries(record)
    .filter(([key, value]) => !NOISE_FIELDS.has(key) && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${fmtValue(value)}`)
  const tail = fields.length > 0 ? `  ${style.dim(fields.join(' '))}` : ''
  return `${style.dim(time)} ${badge} ${record.msg}${tail}`
}

// Parse a line as one of our structured log records, or null if it is plain text.
function tryRecord(text: string): Record<string, unknown> | null {
  if (!(text.startsWith('{') && text.endsWith('}'))) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function emitLine(tag: string, raw: string): void {
  const trimmed = raw.replace(/\s+$/u, '')
  if (trimmed === '') return
  // Render structured records into a readable line first, then scrub. Scrubbing the
  // rendered line (not the JSON source) keeps the record parseable while still
  // redacting any secret that survives into a field value.
  const record = tryRecord(trimmed)
  const body = scrubLine(record ? (formatRecord(record) ?? trimmed) : trimmed)
  if (body === '') return
  process.stdout.write(`${gutter(tag)} ${body}\n`)
}

// Line-buffer a child stream and hand each complete line to the formatter. Partial
// lines are held until their newline arrives so JSON records are never split.
function pipeStream(tag: string, stream: NodeJS.ReadableStream | null | undefined): void {
  if (!stream) return
  stream.setEncoding('utf8')
  let buffer = ''
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      emitLine(tag, buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (buffer !== '') {
      emitLine(tag, buffer)
      buffer = ''
    }
  })
}

interface WebOptions {
  webPort: number
  authPort: number
  build: boolean
  allowOffline: boolean
}

function parseArgs(argv: string[]): WebOptions | 'help' {
  const opts: WebOptions = {
    webPort: DEFAULT_WEB_PORT,
    authPort: DEFAULT_AUTH_PORT,
    build: false,
    allowOffline: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help' || arg === 'help') return 'help'
    else if (arg === '--build') opts.build = true
    else if (arg === '--allow-offline') opts.allowOffline = true
    else if (arg === '--web-port') opts.webPort = Number(argv[++i])
    else if (arg === '--auth-port') opts.authPort = Number(argv[++i])
    else if (arg.startsWith('--web-port=')) opts.webPort = Number(arg.split('=')[1])
    else if (arg.startsWith('--auth-port=')) opts.authPort = Number(arg.split('=')[1])
    else {
      printError(`web: unknown option '${arg}'`)
      return 'help'
    }
  }
  if (!Number.isInteger(opts.webPort) || opts.webPort <= 0) {
    printError('web: --web-port must be a positive integer')
    return 'help'
  }
  if (!Number.isInteger(opts.authPort) || opts.authPort <= 0) {
    printError('web: --auth-port must be a positive integer')
    return 'help'
  }
  return opts
}

function printWebUsage(): void {
  const lines = [
    `${style.title('Usage:')} caracal web [options]`,
    '',
    'Launch the Caracal web console: the browser UI plus its session-guarded',
    'backend-for-frontend, which proxies the admin API without exposing credentials.',
    '',
    style.header('Options'),
    '  --web-port <port>    Port for the web UI (default 3001)',
    '  --auth-port <port>   Port for the backend-for-frontend (default 3002)',
    '  --build              Serve the production build instead of the dev server',
    '  --allow-offline      Launch even if the stack is not running (UI/sign-in only)',
    '  -h, --help           Show help',
    '',
    'The web console proxies the local control plane started by `caracal up`.',
    'Without a running stack it cannot manage zones, applications, policies, or agents;',
    'run `caracal up` first, or pass --allow-offline to launch the UI on its own.',
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

export async function webCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  if (parsed === 'help') {
    printWebUsage()
    process.exit(0)
  }

  const root = repoRoot()
  if (!root || !webInterfaceAvailable()) {
    printError('web: the web console is only available inside the Caracal workspace.')
    process.exit(127)
  }

  // The web console is only useful against a running control plane. Refuse to launch
  // when the stack is down so operators get a clear pointer to `caracal up` instead of
  // a console that cannot reach anything. `--allow-offline` opts out for UI-only work.
  if (!parsed.allowOffline) {
    const base = apiUrl()
    const apiReady = await serviceUp(base)
    if (!apiReady) {
      printError(`web: the Caracal stack is not running (no response from ${base}).`)
      printInfo('The web console proxies the local control plane, which is started by `caracal up`.')
      printInfo('Start the stack first:')
      printInfo(`  ${style.code('caracal up')}`)
      printInfo('Or launch the UI without a backend (sign-in only):')
      printInfo(`  ${style.code('caracal web --allow-offline')}`)
      process.exit(1)
    }
    if (!(await serviceUp(coordinatorUrl()))) {
      printWarn('Coordinator is not responding; Agents and Delegation will be unavailable until the stack is fully up.')
    }
  }

  const pnpm = pnpmInvocation()
  if (!pnpm) {
    printError("web: 'pnpm' was not found; install pnpm to launch the web console.")
    process.exit(127)
  }
  const pnpmCmd = pnpm.cmd
  const pnpmPrefix = pnpm.prefix

  const webOrigin = `http://localhost:${parsed.webPort}`
  const authUrl = `http://localhost:${parsed.authPort}`

  if (parsed.build) {
    printInfo('Building the web UI…')
    const build = spawnSync(pnpmCmd, [...pnpmPrefix, '--dir', 'apps/web', 'build'], {
      cwd: root,
      stdio: 'inherit',
    })
    if (build.status !== 0) {
      printError('web: production build failed.')
      process.exit(build.status ?? 1)
    }
    printInfo('Building the backend-for-frontend…')
    const authBuild = spawnSync(pnpmCmd, [...pnpmPrefix, '--dir', 'apps/auth', 'build'], {
      cwd: root,
      stdio: 'inherit',
    })
    if (authBuild.status !== 0) {
      printError('web: backend-for-frontend build failed.')
      process.exit(authBuild.status ?? 1)
    }
  }

  const children: ChildProcess[] = []
  let shuttingDown = false
  const FORCE_KILL_MS = 5000

  type Role = 'backend' | 'web'
  const procs: Record<Role, ChildProcess | null> = { backend: null, web: null }

  const backendArgs = parsed.build ? ['--dir', 'apps/auth', 'start'] : ['--dir', 'apps/auth', 'dev']
  const webArgs = parsed.build
    ? ['--dir', 'apps/web', 'exec', 'vite', 'preview', '--port', String(parsed.webPort), '--strictPort']
    : ['--dir', 'apps/web', 'exec', 'vite', 'dev', '--port', String(parsed.webPort), '--strictPort']

  const SPEC: Record<Role, { label: string; tag: string; args: string[]; env: NodeJS.ProcessEnv }> = {
    // The auth service is the only CORS-enabled, browser-facing service and hosts
    // the BFF proxy; the web UI must point at it for both sign-in and console data.
    backend: {
      label: 'backend-for-frontend',
      tag: 'bff',
      args: backendArgs,
      env: {
        CARACAL_AUTH_PORT: String(parsed.authPort),
        CARACAL_WEB_ORIGIN: webOrigin,
        ...authStoreEnv(),
      },
    },
    web: { label: 'web UI', tag: 'web', args: webArgs, env: { VITE_CARACAL_AUTH_URL: authUrl } },
  }

  // Each child is a detached process-group leader (see spawnRole), so the pnpm
  // wrapper and its vite/tsx/node descendants share one group. Signalling the whole
  // group is the only reliable way to take the entire tree down — a plain
  // `child.kill()` hits only the pnpm wrapper and orphans the real servers.
  function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) {
      // A second interrupt force-kills anything still winding down.
      for (const child of children) killTree(child, 'SIGKILL')
      process.exit(code)
    }
    shuttingDown = true
    restoreStdin()

    const alive = children.filter((child) => child.exitCode === null && child.signalCode === null)
    if (alive.length === 0) process.exit(code)

    // Wait for every service to actually exit before leaving, so a single Ctrl+C
    // never returns the prompt while a server is still holding a port or the DB.
    const exits = alive.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())))
    for (const child of alive) killTree(child, 'SIGTERM')
    const force = setTimeout(() => {
      for (const child of alive) killTree(child, 'SIGKILL')
    }, FORCE_KILL_MS)
    if (typeof force.unref === 'function') force.unref()

    await Promise.all(exits)
    clearTimeout(force)
    process.exit(code)
  }

  function spawnRole(role: Role): void {
    const spec = SPEC[role]
    const child = spawn(pnpmCmd, [...pnpmPrefix, ...spec.args], {
      cwd: root,
      // The parent owns stdin so it can handle restart keys; child output is captured
      // and re-rendered through the formatter rather than inherited raw.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detach so each child leads its own process group: it stays out of the TTY's
      // foreground group (a single Ctrl+C reaches only the launcher) and can be torn
      // down as a whole group, descendants included.
      detached: true,
      // Children pipe to a non-TTY, which makes tools like Vite drop their colors.
      // Force color on when the launcher itself owns a TTY so the aggregated stream
      // stays readable; respect an explicit operator override.
      env: {
        ...process.env,
        ...(process.stdout.isTTY ? { FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } : {}),
        ...spec.env,
      },
    })
    procs[role] = child
    children.push(child)
    pipeStream(spec.tag, child.stdout)
    pipeStream(spec.tag, child.stderr)
    child.on('error', (err) => {
      printError(`web: failed to start ${spec.label}: ${err.message}`)
      if (!shuttingDown) void shutdown(1)
    })
    child.on('exit', () => {
      if (shuttingDown) return
      // An exit during an explicit restart is expected; only a stale current
      // process exiting on its own is a real failure.
      if (procs[role] === child) {
        printError(`web: ${spec.label} exited unexpectedly.`)
        void shutdown(1)
      }
    })
  }

  function restartRole(role: Role): void {
    const current = procs[role]
    procs[role] = null
    if (current) killTree(current, 'SIGTERM')
    printInfo(`Restarting ${SPEC[role].label}…`)
    spawnRole(role)
  }

  let rawStdin = false
  function restoreStdin(): void {
    if (rawStdin && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false)
      } catch {
        /* ignore */
      }
    }
  }

  function listenForKeys(): void {
    if (!process.stdin.isTTY) return
    rawStdin = true
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (key: string) => {
      switch (key) {
        case '\u0003': // Ctrl+C
        case 'q':
          void shutdown(0)
          break
        case 'r':
          restartRole('backend')
          restartRole('web')
          break
        case 'f':
          restartRole('web')
          break
        case 'b':
          restartRole('backend')
          break
        default:
          break
      }
    })
  }

  spawnRole('backend')
  spawnRole('web')

  process.stdout.write(
    [
      '',
      style.title('Caracal web console'),
      `  ${style.label('Web UI')}    ${webOrigin}`,
      `  ${style.label('Backend')}   ${authUrl}  (session-guarded; proxies the admin API)`,
      `  ${style.label('Mode')}      ${parsed.build ? 'production build' : 'development'}`,
      '',
      `  ${style.label('r')} restart both   ${style.label('f')} restart frontend   ${style.label('b')} restart backend`,
      `  ${style.label('q')} or ${style.label('Ctrl+C')} to stop`,
      '',
      `  ${style.dim('logs')}  ${paintTag('web')} ${style.dim('web UI')}   ${paintTag('bff')} ${style.dim('backend')}   ${style.dim('· structured, secret-scrubbed')}`,
      '',
    ].join('\n') + '\n',
  )

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))
  // Final safety net: if the launcher exits for any other reason, take the detached
  // service groups down with it rather than leaking ports and an open database.
  process.on('exit', () => {
    for (const child of children) {
      const pid = child.pid
      if (pid === undefined) continue
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  })
  listenForKeys()
}
