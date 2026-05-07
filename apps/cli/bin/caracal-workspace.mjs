#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workspace entry point: pins CARACAL_REPO_ROOT to the pnpm invocation directory.

import { createRequire } from 'module'
import { join } from 'path'

const root = process.env.INIT_CWD || process.env.PWD || process.cwd()
process.env.CARACAL_REPO_ROOT = root

import(join(root, 'apps/cli/bin/caracal.mjs')).catch((err) => {
  process.stderr.write(`caracal: ${err?.message ?? err}\n`)
  process.exit(1)
})
