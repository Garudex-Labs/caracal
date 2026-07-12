// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// External-consumer contract for the published TypeScript SDK root and advanced export maps.

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const packageDir = resolve(root, 'packages/sdk/ts')
const fixture = await mkdtemp(resolve(tmpdir(), 'caracal-sdk-consumer-'))

try {
  const scope = resolve(fixture, 'node_modules/@caracalai')
  await mkdir(scope, { recursive: true })
  await symlink(packageDir, resolve(scope, 'sdk'), 'dir')
  await writeFile(
    resolve(fixture, 'consumer.mjs'),
    `
      import { Authority, Caracal, CoordinatorError, CredentialsUnavailableError } from '@caracalai/sdk'
      import { bind, captureContext, Caracal as AdvancedCaracal, encodeEnvelope } from '@caracalai/sdk/advanced'

      if (typeof Authority !== 'object' || typeof Authority.narrow !== 'function') {
        throw new Error('Authority is not exported as a helper object')
      }
      for (const [name, value] of Object.entries({
        Caracal,
        CoordinatorError,
        CredentialsUnavailableError,
        bind,
        captureContext,
        AdvancedCaracal,
        createAdvancedClientFromEnv: AdvancedCaracal.fromEnv,
        encodeEnvelope,
      })) {
        if (typeof value !== 'function') throw new Error(name + ' is not exported as a function')
      }
    `,
  )

  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['consumer.mjs'], { cwd: fixture, stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`consumer exited with ${signal ?? code}`))
    })
  })
} finally {
  await rm(fixture, { recursive: true, force: true })
}
