// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal credential read <resource>`: prints a one-shot 15-min token to stdout.

import { credentialRead } from '@caracalai/cli-core'
import type { CliConfig } from '../config.ts'
import { printError } from '../style.ts'

export async function credentialReadCommand(resource: string, cfg: CliConfig): Promise<void> {
  if (!resource) {
    printError('Usage: caracal credential read <resource>')
    process.exit(1)
  }
  try {
    const token = await credentialRead({ cfg, resource })
    process.stdout.write(token + '\n')
  } catch (err) {
    const desc = err instanceof Error ? err.message : String(err)
    process.stderr.write(JSON.stringify({ resource, reason: desc }) + '\n')
    process.exit(1)
  }
}
