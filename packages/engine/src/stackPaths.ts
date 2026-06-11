// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves StackPaths for dev, rc, and stable modes.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bootstrapSecrets, prepareDevSecrets } from './secrets.js'
import { installRuntimeAssets, runtimePaths } from './runtime.js'
import type { StackPaths } from './stack.js'
import type { CaracalMode } from '@caracalai/core'

export type StackMode = CaracalMode

const DEV_COMPOSE_DIR = ['infra', 'docker'] as const
const DEV_COMPOSE_FILENAME = 'docker-compose.yml'

export interface ResolveStackPathsOptions {
  mode?: StackMode
  home?: string
  repoRoot?: string
  onInfo?: (message: string) => void
}

export interface ActiveLocalStackRuntime {
  mode: StackMode
  version?: string
  registry?: string
  home?: string
  repoRoot?: string
  composeFile?: string
  secretsDir?: string
}

interface DockerInspectContainer {
  Config?: {
    Image?: string
    Env?: string[]
    Labels?: Record<string, string>
  }
  Mounts?: Array<{ Source?: string; Destination?: string }>
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>
  }
}

export function resolveStackPaths(opts: ResolveStackPathsOptions = {}): StackPaths {
  const mode = opts.mode ?? defaultMode()
  if (mode === 'dev') return devPaths(opts)
  return installedPaths(opts, mode)
}

function defaultMode(): StackMode {
  const override = process.env.CARACAL_MODE
  if (override === 'dev' || override === 'rc' || override === 'stable') return override
  if (override) {
    throw new Error(`CARACAL_MODE must be 'dev', 'rc', or 'stable' (got '${override}')`)
  }
  return process.env.CARACAL_REPO_ROOT ? 'dev' : 'stable'
}

function devPaths(opts: ResolveStackPathsOptions): StackPaths {
  const repoRoot = opts.repoRoot ?? process.env.CARACAL_REPO_ROOT
  if (!repoRoot) {
    throw new Error(
      "CARACAL_MODE=dev requires CARACAL_REPO_ROOT; invoke via 'pnpm caracal' from inside the repo.",
    )
  }
  const composeFile = process.env.CARACAL_COMPOSE_FILE ?? join(repoRoot, ...DEV_COMPOSE_DIR, DEV_COMPOSE_FILENAME)
  const defaultsEnvFile = join(repoRoot, ...DEV_COMPOSE_DIR, 'dev.env')
  const overrideEnvFile = join(repoRoot, ...DEV_COMPOSE_DIR, 'local.env')
  const secrets = prepareDevSecrets(repoRoot)
  const report = bootstrapSecrets(secrets)
  if (report.filesCreated.length > 0) {
    opts.onInfo?.(`generated ${report.filesCreated.length} operator secret file(s) under ${secrets.secretsDir}`)
  }
  return {
    composeFile,
    envFiles: existsSync(overrideEnvFile) ? [defaultsEnvFile, overrideEnvFile] : [defaultsEnvFile],
    cwd: repoRoot,
    mode: 'dev',
    secretsDir: secrets.secretsDir,
  }
}

function installedPaths(opts: ResolveStackPathsOptions, mode: Exclude<StackMode, 'dev'>): StackPaths {
  const paths = runtimePaths(opts.home)
  const report = installRuntimeAssets(paths, mode)
  if (report.created) opts.onInfo?.(`provisioned runtime assets at ${paths.home}`)
  const composeFile = process.env.CARACAL_COMPOSE_FILE ?? paths.composeFile
  const overrideEnvFile = process.env.CARACAL_ENV_FILE ?? paths.overrideEnvFile
  return {
    composeFile,
    envFiles: [overrideEnvFile],
    cwd: paths.home,
    mode,
    secretsDir: paths.secretsDir,
  }
}

function dockerOutput(args: string[]): string | undefined {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
  const text = result.stdout.trim()
  return text.length > 0 ? text : undefined
}

function inspectContainers(ids: string[]): DockerInspectContainer[] {
  if (ids.length === 0) return []
  const text = dockerOutput(['inspect', ...ids])
  if (!text) return []
  const parsed = JSON.parse(text) as unknown
  return Array.isArray(parsed) ? parsed as DockerInspectContainer[] : []
}

function envValue(env: string[] | undefined, key: string): string | undefined {
  const prefix = `${key}=`
  return env?.find((entry) => entry.startsWith(prefix))?.slice(prefix.length)
}

function stackMode(value: string | undefined): StackMode | undefined {
  if (value === 'dev' || value === 'rc' || value === 'stable') return value
  return undefined
}

function imageRuntime(image: string | undefined): Pick<ActiveLocalStackRuntime, 'version' | 'registry'> {
  const marker = 'caracal-api:'
  const index = image?.lastIndexOf(marker) ?? -1
  if (!image || index < 0) return {}
  const tag = image.slice(index + marker.length)
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  return { version, registry: image.slice(0, index) || undefined }
}

function publishesApiPort(container: DockerInspectContainer): boolean {
  return container.NetworkSettings?.Ports?.['3000/tcp']?.some((port) => port.HostPort === '3000') === true
}

function mountedSecretDir(container: DockerInspectContainer): string | undefined {
  const mount = container.Mounts?.find((item) => item.Source && item.Destination?.startsWith('/run/secrets/'))
  return mount?.Source ? dirname(mount.Source) : undefined
}

function devRepoRoot(workingDir: string | undefined): string | undefined {
  if (!workingDir) return undefined
  let root = workingDir
  for (let i = 0; i < DEV_COMPOSE_DIR.length; i++) root = dirname(root)
  return root
}

export function detectActiveLocalStackRuntime(): ActiveLocalStackRuntime | undefined {
  const ids = dockerOutput([
    'ps',
    '--filter',
    'label=com.docker.compose.service=api',
    '--filter',
    'status=running',
    '--format',
    '{{.ID}}',
  ])?.split(/\s+/).filter(Boolean) ?? []
  const containers = inspectContainers(ids)
  const container = containers.find(publishesApiPort) ?? containers[0]
  if (!container) return undefined
  const labels = container.Config?.Labels ?? {}
  const mode = stackMode(envValue(container.Config?.Env, 'CARACAL_MODE'))
  if (!mode) return undefined
  const home = labels['com.docker.compose.project.working_dir']
  const composeFile = labels['com.docker.compose.project.config_files']?.split(',')[0]
  return {
    mode,
    ...imageRuntime(container.Config?.Image),
    home: mode === 'dev' ? undefined : home,
    repoRoot: mode === 'dev' ? devRepoRoot(home) : undefined,
    composeFile,
    secretsDir: mountedSecretDir(container),
  }
}
