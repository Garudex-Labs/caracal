#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal TUI launcher: defers to the TypeScript entry under Node 24 native type stripping.

import('../src/index.ts').catch((err) => {
  process.stderr.write(`caracal-tui: ${err?.message ?? err}\n`)
  process.exit(1)
})
