// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Side-effect module that removes CARACAL_* values auto-loaded from the
// current working directory's dotenv files so the CLI never sees them.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES = ['.env', '.env.local', '.env.production', '.env.development']

export function scrubCwdEnv(cwd: string, env: NodeJS.ProcessEnv): void {
  for (const name of FILES) {
    const path = join(cwd, name)
    if (!existsSync(path)) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(CARACAL_[A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      let value = m[2]
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1)
      }
      if (env[m[1]] === value) delete env[m[1]]
    }
  }
}

scrubCwdEnv(process.cwd(), process.env)
