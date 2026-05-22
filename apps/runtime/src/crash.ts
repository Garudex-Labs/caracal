// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Re-export of the shared crash handler so CLI hosts (cli.ts, repl.ts) keep a stable import path.

export { installCrashHandlers } from '@caracalai/engine/crash'
