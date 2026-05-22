// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime command registry: binds canonical command descriptors to their executor functions inside a single Caracal binary.

import type { CommandDescriptor } from '@caracalai/engine/commands'
import type { CliConfig } from './config.ts'

export type Executor = (argv: string[], cfg?: CliConfig) => Promise<void> | void

interface CommandBinding {
  readonly descriptor: CommandDescriptor
  readonly run: Executor
}

export interface CommandRegistry {
  readonly byName: ReadonlyMap<string, CommandBinding>
  readonly ordered: readonly CommandBinding[]
}

export function buildRegistry(
  table: readonly CommandDescriptor[],
  executors: Record<string, Executor>,
): CommandRegistry {
  const byName = new Map<string, CommandBinding>()
  const ordered: CommandBinding[] = []
  const missing: string[] = []
  for (const descriptor of table) {
    const run = executors[descriptor.name]
    if (!run) {
      missing.push(descriptor.name)
      continue
    }
    const binding: CommandBinding = { descriptor, run }
    byName.set(descriptor.name, binding)
    ordered.push(binding)
  }
  if (missing.length > 0) {
    throw new Error(
      `command registry is missing executors for: ${missing.join(', ')} — every descriptor must be wired so dispatch and autocomplete never drift.`,
    )
  }
  const extras = Object.keys(executors).filter((n) => !byName.has(n))
  if (extras.length > 0) {
    throw new Error(
      `command registry has executors with no descriptor: ${extras.join(', ')} — add them to @caracalai/core/commands or remove the executor.`,
    )
  }
  return { byName, ordered }
}
