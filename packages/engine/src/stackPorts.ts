// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Compose-derived host-port discovery and conflict checks for stack startup.

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { stackComposeArgv, type StackPaths } from './stack.js'

interface ComposePort {
  host_ip?: string
  published?: string | number
  protocol?: string
}

interface ComposeService {
  depends_on?: Record<string, unknown> | string[]
  ports?: ComposePort[]
}

interface ComposeConfig {
  services?: Record<string, ComposeService>
}

interface ComposePublisher {
  URL?: string
  PublishedPort?: number
  Protocol?: string
}

interface ComposeProcess {
  State?: string
  Publishers?: ComposePublisher[]
}

export interface StackPortBinding {
  service: string
  host: string
  port: number
  protocol: string
}

export type StackPortConflict = StackPortBinding

export interface StackPortPreflightResult {
  conflicts: StackPortConflict[]
  projectExisted: boolean
}

export interface StackPortPreflightOpts {
  paths: StackPaths
  args: string[]
  env?: Record<string, string | undefined>
  isPortAvailable?: (binding: StackPortBinding) => Promise<boolean>
}

function composeOutput(opts: StackPortPreflightOpts, args: string[]): string {
  const [command, ...argv] = stackComposeArgv(opts.paths, args)
  const result = spawnSync(command, argv, {
    cwd: opts.paths.cwd,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`could not inspect Docker Compose port bindings (${args.join(' ')})`)
  }
  return result.stdout ?? ''
}

function selectedServices(config: ComposeConfig, args: string[]): Set<string> {
  const services = config.services ?? {}
  const requested = args.filter((arg) => Object.hasOwn(services, arg))
  const selected = new Set(requested.length > 0 ? requested : Object.keys(services))
  const pending = [...selected]
  while (pending.length > 0) {
    const service = pending.pop()!
    const dependencies = services[service]?.depends_on
    const names = Array.isArray(dependencies) ? dependencies : Object.keys(dependencies ?? {})
    for (const dependency of names) {
      if (selected.has(dependency)) continue
      selected.add(dependency)
      pending.push(dependency)
    }
  }
  return selected
}

function configuredBindings(config: ComposeConfig, args: string[]): StackPortBinding[] {
  const selected = selectedServices(config, args)
  const bindings: StackPortBinding[] = []
  for (const [service, value] of Object.entries(config.services ?? {})) {
    if (!selected.has(service)) continue
    for (const port of value.ports ?? []) {
      const published = Number(port.published)
      const protocol = (port.protocol ?? 'tcp').toLowerCase()
      if (!Number.isInteger(published) || published < 1 || published > 65535 || protocol !== 'tcp') continue
      bindings.push({ service, host: port.host_ip || '0.0.0.0', port: published, protocol })
    }
  }
  return bindings
}

function parseComposeProcesses(raw: string): ComposeProcess[] {
  const value = raw.trim()
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as ComposeProcess | ComposeProcess[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return value.split(/\r?\n/).map((line) => JSON.parse(line) as ComposeProcess)
  }
}

function normalizedHost(host: string | undefined): string {
  const value = (host ?? '').trim().toLowerCase()
  if (value === '' || value === '::' || value === '0.0.0.0') return '*'
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function targetOwnsBinding(binding: StackPortBinding, processes: ComposeProcess[]): boolean {
  const expectedHost = normalizedHost(binding.host)
  return processes.some((process) => {
    if ((process.State ?? '').toLowerCase() !== 'running') return false
    return (process.Publishers ?? []).some((publisher) => {
      if (publisher.PublishedPort !== binding.port || (publisher.Protocol ?? 'tcp').toLowerCase() !== binding.protocol) return false
      const ownerHost = normalizedHost(publisher.URL)
      return ownerHost === '*' || ownerHost === expectedHost
    })
  })
}

function portAvailable(binding: StackPortBinding): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: binding.host, port: binding.port, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

export async function stackPortPreflight(opts: StackPortPreflightOpts): Promise<StackPortPreflightResult> {
  const config = JSON.parse(composeOutput(opts, ['config', '--format', 'json'])) as ComposeConfig
  const bindings = configuredBindings(config, opts.args)
  const processes = parseComposeProcesses(composeOutput(opts, ['ps', '--all', '--format', 'json']))
  const check = opts.isPortAvailable ?? portAvailable
  const conflicts: StackPortConflict[] = []
  for (const binding of bindings) {
    if (targetOwnsBinding(binding, processes) || (await check(binding))) continue
    conflicts.push(binding)
  }
  return { conflicts, projectExisted: processes.length > 0 }
}
