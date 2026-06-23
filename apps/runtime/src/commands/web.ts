// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Optional interface launcher that runs the Caracal web console (UI) and its session-guarded backend-for-frontend together.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { printError, printInfo, style } from '../style.ts'

const EXT = process.platform === 'win32' ? '.exe' : ''
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const DEFAULT_WEB_PORT = 3001
const DEFAULT_AUTH_PORT = 3002

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

interface WebOptions {
  webPort: number
  authPort: number
  build: boolean
}

function parseArgs(argv: string[]): WebOptions | 'help' {
  const opts: WebOptions = { webPort: DEFAULT_WEB_PORT, authPort: DEFAULT_AUTH_PORT, build: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help' || arg === 'help') return 'help'
    else if (arg === '--build') opts.build = true
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
    '  -h, --help           Show help',
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

export function webCommand(argv: string[]): void {
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
  }

  const children: ChildProcess[] = []
  let shuttingDown = false

  function shutdown(code: number): never {
    shuttingDown = true
    for (const child of children) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    process.exit(code)
  }

  function start(label: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    const child = spawn(pnpmCmd, [...pnpmPrefix, ...args], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    })
    child.on('error', (err) => {
      printError(`web: failed to start ${label}: ${err.message}`)
      if (!shuttingDown) shutdown(1)
    })
    child.on('exit', (status) => {
      if (!shuttingDown) {
        printError(`web: ${label} exited unexpectedly.`)
        shutdown(status ?? 1)
      }
    })
    children.push(child)
    return child
  }

  // The auth service is the only CORS-enabled, browser-facing service and hosts
  // the BFF proxy; the web UI must point at it for both sign-in and console data.
  start('backend-for-frontend', ['--dir', 'apps/auth', 'start'], {
    CARACAL_AUTH_PORT: String(parsed.authPort),
    CARACAL_WEB_ORIGIN: webOrigin,
  })

  const webArgs = parsed.build
    ? ['--dir', 'apps/web', 'exec', 'vite', 'preview', '--port', String(parsed.webPort), '--strictPort']
    : ['--dir', 'apps/web', 'exec', 'vite', 'dev', '--port', String(parsed.webPort), '--strictPort']
  start('web UI', webArgs, { VITE_CARACAL_AUTH_URL: authUrl })

  process.stdout.write(
    [
      '',
      style.title('Caracal web console'),
      `  ${style.label('Web UI')}    ${webOrigin}`,
      `  ${style.label('Backend')}   ${authUrl}  (session-guarded; proxies the admin API)`,
      `  ${style.label('Mode')}      ${parsed.build ? 'production build' : 'development'}`,
      '',
      '  Press Ctrl+C to stop both services.',
      '',
    ].join('\n') + '\n',
  )

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
}
