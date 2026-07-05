// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Version output tests cover structured rendering and color environment flags.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatVersionOutput } from '../../../../packages/engine/src/versionOutput.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

function stream(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY } as NodeJS.WriteStream
}

describe('formatVersionOutput', () => {
  it('renders plain structured version metadata when color is disabled', () => {
    vi.stubEnv('NO_COLOR', '1')
    expect(
      formatVersionOutput(
        {
          binary: 'caracal',
          version: '1.2.3',
          mode: 'stable',
          sha: 'abc123',
        },
        stream(true),
      ),
    ).toBe(['Caracal', '  binary   caracal', '  version  1.2.3', '  mode     stable', '  sha      abc123', ''].join('\n'))
  })

  it('honors FORCE_COLOR and CARACAL_NO_COLOR precedence', () => {
    vi.stubEnv('FORCE_COLOR', '1')
    expect(
      formatVersionOutput(
        {
          binary: 'caracal',
          version: '1.2.3',
          mode: 'dev',
          sha: 'abc123',
        },
        stream(false),
      ),
    ).toContain('\x1b[')

    vi.stubEnv('CARACAL_NO_COLOR', '1')
    expect(
      formatVersionOutput(
        {
          binary: 'caracal',
          version: '1.2.3',
          mode: 'dev',
          sha: 'abc123',
        },
        stream(true),
      ),
    ).not.toContain('\x1b[')
  })
})
