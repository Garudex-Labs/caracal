// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control service entry point: launches the external control HTTP surface only when CARACAL_CONTROL_ENABLED=true.

import { assertPublishedSafe, createLogger } from '@caracalai/core'
import { loadConfig } from './config.js'
import { buildServer } from './server.js'

assertPublishedSafe()

async function main(): Promise<void> {
  const enabled = process.env.CARACAL_CONTROL_ENABLED
  const bootLog = createLogger('control', (process.env.LOG_LEVEL as 'info') ?? 'info')
  if (enabled !== 'true') {
    bootLog.info('control surface disabled; exiting (set CARACAL_CONTROL_ENABLED=true to enable)', { enabled: enabled ?? '' })
    return
  }

  let cfg
  try {
    cfg = loadConfig()
  } catch (err) {
    bootLog.error('control config invalid', { err: String(err) })
    process.exit(1)
  }

  const log = createLogger('control', cfg.logLevel as 'info')
  const { app, close } = await buildServer(cfg, log)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutdown requested', { signal })
    try {
      await close()
    } catch (err) {
      log.error('graceful shutdown failed', { err: String(err) })
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', { reason: String(reason) })
    process.exit(1)
  })
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { err: err.stack ?? err.message })
    process.exit(1)
  })

  try {
    await app.listen({ port: cfg.port, host: cfg.host })
    log.info('control surface listening', { port: cfg.port, host: cfg.host })
  } catch (err) {
    log.error('listen failed', { err: String(err) })
    process.exit(1)
  }
}

void main()
