#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Generates per-environment secret files for compose-mounted Docker secrets; cross-platform.

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, 'files')
const isPosix = process.platform !== 'win32'

mkdirSync(dir, { recursive: true })
if (isPosix) chmodSync(dir, 0o700)

function writeOnce(name, bytes) {
  const path = resolve(dir, name)
  try {
    if (statSync(path).size > 0) {
      if (isPosix) chmodSync(path, 0o444)
      console.log(`skip ${name} (exists)`)
      return
    }
  } catch {}
  writeFileSync(path, randomBytes(bytes).toString('hex'), { mode: 0o444 })
  if (isPosix) chmodSync(path, 0o444)
  console.log(`wrote ${name}`)
}

writeOnce('postgresPassword', 24)
writeOnce('redisPassword', 24)
writeOnce('caracalAdminToken', 32)
writeOnce('zoneKek', 32)
writeOnce('auditHmacKey', 32)
writeOnce('streamsHmacKey', 32)

console.log('')
console.log(`secret files in ${dir}`)
console.log('they are gitignored; never commit')
