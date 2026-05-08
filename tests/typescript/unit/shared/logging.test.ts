// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TypeScript shared logging tests for JSON emission and level filtering.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../../../packages/core/ts/src/logging.js'

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits structured JSON to stderr', () => {
    let output = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += chunk.toString()
      return true
    })

    createLogger('api', 'info').info('ready', { port: 3000 })

    expect(JSON.parse(output)).toMatchObject({ level: 'info', service: 'api', msg: 'ready', port: 3000 })
  })

  it('filters messages below the configured level', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const logger = createLogger('sts', 'warn')
    logger.info('hidden')
    logger.error('visible')

    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({ level: 'error', msg: 'visible' })
  })
})