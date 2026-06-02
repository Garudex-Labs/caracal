// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// FormView focus, validation, secret reveal, and dispose-abort tests.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { FormView } from '../../../../apps/console/src/views/form.ts'
import type { App } from '../../../../apps/console/src/screen.ts'
import { AdminApiError } from '../../../../packages/admin/ts/src/errors.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeApp(): App {
  const status: { text: string; kind: string }[] = []
  const popped: number[] = []
  const app = {
    invalidate: vi.fn(),
    push: vi.fn(),
    pop: vi.fn(() => { popped.push(1) }),
    setStatus: vi.fn((t: string, k: 'info' | 'error' = 'info') => { status.push({ text: t, kind: k }) }),
    current: vi.fn(),
    exit: vi.fn(async () => {}),
    replaceTop: vi.fn(),
    bannerLeft: '',
    bannerRight: '',
  } as unknown as App
  ;(app as unknown as { _status: typeof status; _popped: number[] })._status = status
  ;(app as unknown as { _status: typeof status; _popped: number[] })._popped = popped
  return app
}

describe('FormView focus', () => {
  it('moves focus with tab and arrow keys while alphabet keys remain input-safe', async () => {
    const view = new FormView({
      title: 't',
      fields: [
        { key: 'a', label: 'a', kind: 'bool', default: 'false' },
        { key: 'b', label: 'b', kind: 'bool', default: 'false' },
      ],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }
    await view.onKey('tab', ctx)
    expect((view as unknown as { focus: number }).focus).toBe(1)
    await view.onKey('j', ctx)
    expect((view as unknown as { focus: number }).focus).toBe(1)
    await view.onKey('down', ctx)
    expect((view as unknown as { focus: number }).focus).toBe(2)
  })
})

describe('FormView input UX', () => {
  it('renders required text fields as editable inputs', () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'name', label: 'name', kind: 'text', required: true }],
      onSubmit: async () => {},
    })
    const lines = view.render({ app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' }).join('\n')
    expect(lines).toContain('Type or paste into fields')
    expect(lines).toContain('name *')
    expect(lines).toContain('[ <name> ]')
  })

  it('accepts pasted text chunks in text fields', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'id', label: 'application id', kind: 'text', required: true }],
      onSubmit: async () => {},
    })
    await view.onKey('019e3025-999e-753c-8a09-7c8acc3f6480', { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })
    expect(view.values_().id).toBe('019e3025-999e-753c-8a09-7c8acc3f6480')
  })

  it('accepts bracketed paste in text fields', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'name', label: 'name', kind: 'text' }],
      onSubmit: async () => {},
    })
    await view.onKey('\u001b[200~Ryan\'s Workflow\u001b[201~', { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })
    expect(view.values_().name).toBe('Ryan\'s Workflow')
  })

  it('opens advanced fields on a separate page and keeps them optional', async () => {
    const submit = vi.fn(async () => {})
    const view = new FormView({
      title: 't',
      fields: [
        { key: 'name', label: 'name', kind: 'text' },
        { key: 'identifier', label: 'identifier', kind: 'text', advanced: true, required: true },
      ],
      onSubmit: submit,
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }

    let lines = view.render(ctx).join('\n')
    expect(lines).toContain('Advanced options')
    expect(lines).toContain('open optional settings')
    expect(lines).not.toContain('identifier')

    await view.onKey('?', ctx)
    expect(app.push).toHaveBeenCalled()

    await view.onKey('down', ctx)
    await view.onKey('right', ctx)
    const advanced = vi.mocked(app.push).mock.calls.at(-1)![0] as FormView
    expect(advanced).toBeInstanceOf(FormView)
    lines = advanced.render(ctx).join('\n')
    expect(lines).toContain('identifier')
    expect(lines).not.toContain('identifier *')

    ;(advanced as unknown as { focus: number }).focus = 1
    await advanced.onKey('enter', ctx)
    ;(view as unknown as { focus: number }).focus = 2
    await view.onKey('enter', ctx)
    expect(submit).toHaveBeenCalledWith({ name: '', identifier: '' }, expect.anything())
  })

  it('keeps select fields bounded to options and opens an option picker with right arrow', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'registration_method', label: 'registration method', kind: 'select', options: ['managed', 'dcr'], default: 'managed' }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }

    await view.onKey('p', ctx)
    await view.onKey('u', ctx)
    expect(view.values_().registration_method).toBe('managed')
    await view.onKey('right', ctx)

    const picker = vi.mocked(app.push).mock.calls[0]![0] as { onKey: FormView['onKey']; render: FormView['render'] }
    await picker.onKey('down', ctx)
    expect(picker.render(ctx).join('\n')).toContain('dcr')
    await picker.onKey('enter', ctx)
    expect(view.values_().registration_method).toBe('dcr')
  })

  it('shows readable labels for select options while submitting stored values', async () => {
    const view = new FormView({
      title: 't',
      fields: [{
        key: 'provider_type',
        label: 'provider type',
        kind: 'select',
        options: ['oauth2_authorization_code', 'oauth2_client_credentials'],
        optionLabels: {
          oauth2_authorization_code: 'OAuth 2.0 authorization code',
          oauth2_client_credentials: 'OAuth 2.0 client credentials',
        },
        default: 'oauth2_authorization_code',
      }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }

    expect(view.render(ctx).join('\n')).toContain('OAuth 2.0 authorization code')
    expect(view.render(ctx).join('\n')).not.toContain('oauth2_authorization_code')
    await view.onKey('right', ctx)

    const picker = vi.mocked(app.push).mock.calls[0]![0] as { onKey: FormView['onKey']; render: FormView['render'] }
    expect(picker.render(ctx).join('\n')).toContain('OAuth 2.0 client credentials')
    await picker.onKey('down', ctx)
    await picker.onKey('enter', ctx)
    expect(view.values_().provider_type).toBe('oauth2_client_credentials')
  })

  it('filters select options, opens option info, and handles empty matches', async () => {
    const view = new FormView({
      title: 'provider type',
      fields: [{
        key: 'provider_type',
        label: 'provider type',
        kind: 'select',
        options: ['oauth2_authorization_code', 'oauth2_client_credentials', 'api_key'],
        optionLabels: {
          oauth2_authorization_code: 'OAuth 2.0 authorization code',
          oauth2_client_credentials: 'OAuth 2.0 client credentials',
          api_key: 'API key',
        },
        default: 'oauth2_authorization_code',
      }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 6, cols: 100 }, status: '' }

    await view.onKey('right', ctx)
    const picker = vi.mocked(app.push).mock.calls.at(-1)![0] as { onKey: FormView['onKey']; render: FormView['render']; hints: () => string[] }
    expect(picker.hints()).toContain('type:search')
    await picker.onKey('client', ctx)
    expect(picker.render(ctx).join('\n')).toContain('OAuth 2.0 client credentials')
    await picker.onKey('?', ctx)
    expect(app.push).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('OAuth 2.0 client credentials') }))
    await picker.onKey('home', ctx)
    await picker.onKey('end', ctx)
    await picker.onKey('backspace', ctx)
    await picker.onKey('zzzz', ctx)
    expect(picker.render(ctx).join('\n')).toContain('No matches')
    await picker.onKey('esc', ctx)
    expect(app.pop).toHaveBeenCalled()
  })

  it('submits only fields relevant to the current dynamic selection', async () => {
    const submit = vi.fn(async () => {})
    const view = new FormView({
      title: 't',
      fields: [
        { key: 'mode', label: 'mode', kind: 'select', options: ['a', 'b'], default: 'a' },
        { key: 'a_value', label: 'a value', kind: 'text', visible: (values) => values.mode === 'a' },
        { key: 'b_value', label: 'b value', kind: 'text', required: true, visible: (values) => values.mode === 'b' },
      ],
      onSubmit: submit,
    })
    ;(view as unknown as { values: Record<string, string> }).values = {
      mode: 'b',
      a_value: 'stale',
      b_value: 'current',
    }
    ;(view as unknown as { focus: number }).focus = 3

    await view.onKey('enter', { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })

    expect(submit).toHaveBeenCalledWith({ mode: 'b', a_value: '', b_value: 'current' }, expect.anything())
  })

  it('uses dependency metadata for live visibility and field info', async () => {
    const view = new FormView({
      title: 't',
      fields: [
        { key: 'mode', label: 'mode', kind: 'select', options: ['basic', 'gateway'], default: 'basic' },
        { key: 'url', label: 'upstream URL', kind: 'text', required: true, dependsOn: { mode: 'gateway' } },
      ],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 12, cols: 100 }, status: '' }

    expect(view.render(ctx).join('\n')).not.toContain('upstream URL')
    expect(view.render(ctx).join('\n')).toContain('mode ↳')
    ;(view as unknown as { values: Record<string, string> }).values.mode = 'gateway'
    expect(view.render(ctx).join('\n')).toContain('upstream URL *')
    ;(view as unknown as { focus: number }).focus = 1
    await view.onKey('?', ctx)
    const info = vi.mocked(app.push).mock.calls.at(-1)![0] as { render: FormView['render'] }
    const help = info.render(ctx).join('\n')
    expect(help).toContain('Shown when mode is gateway')
    expect(help).toContain('Impact')
    expect(help).toContain('Upstream values affect where Gateway sends protected traffic')
  })

  it('uses operational field help instead of generic boilerplate', async () => {
    const view = new FormView({
      title: 'create object',
      fields: [{ key: 'name', label: 'name', kind: 'text', required: true }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 12, cols: 100 }, status: '' }

    await view.onKey('?', ctx)

    const info = vi.mocked(app.push).mock.calls.at(-1)![0] as { render: FormView['render'] }
    const help = info.render(ctx).join('\n')
    expect(help).toContain('operator-facing label')
    expect(help).toContain('operators should recognize')
    expect(help).not.toContain('form needs a concrete value')
    expect(help).not.toContain('supplies the value used by the current Console workflow')
  })

  it('uses numeric examples for lifetime and limit fields', async () => {
    const view = new FormView({
      title: 'numeric fields',
      fields: [{ key: 'expires_in', label: 'client lifetime seconds', kind: 'text' }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 12, cols: 100 }, status: '' }

    await view.onKey('?', ctx)

    const info = vi.mocked(app.push).mock.calls.at(-1)![0] as { render: FormView['render'] }
    const help = info.render(ctx).join('\n')
    expect(help).toContain('Example')
    expect(help).toContain('3600')
    expect(help).toContain('numeric operational limit')
    expect(help).not.toContain('Son of Anton')
  })

  it('uses entity-appropriate examples for provider fields', async () => {
    const view = new FormView({
      title: 'create provider',
      fields: [{ key: 'name', label: 'provider name', kind: 'text', required: true }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 12, cols: 100 }, status: '' }

    await view.onKey('?', ctx)

    const info = vi.mocked(app.push).mock.calls.at(-1)![0] as { render: FormView['render'] }
    const help = info.render(ctx).join('\n')
    expect(help).toContain('Hooli OAuth')
    expect(help).not.toContain('Son of Anton')
  })

  it('explains forward Caracal identity as Gateway mandate forwarding', async () => {
    const view = new FormView({
      title: 'create provider',
      fields: [{ key: 'forward_caracal_identity', label: 'forward Caracal identity', kind: 'bool', advanced: true }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 14, cols: 110 }, status: '' }

    await view.onKey('right', ctx)
    const advanced = vi.mocked(app.push).mock.calls.at(-1)![0] as FormView
    await advanced.onKey('?', ctx)

    const info = vi.mocked(app.push).mock.calls.at(-1)![0] as { render: FormView['render'] }
    const help = info.render(ctx).join('\n')
    expect(help).toContain('provider credential')
    expect(help).toContain('X-Caracal-Identity')
    expect(help).toContain('trusted upstream')
  })

  it('marks fields that control conditional fields and explains affected fields', async () => {
    const view = new FormView({
      title: 'conditional',
      fields: [
        { key: 'mode', label: 'mode', kind: 'select', options: ['basic', 'advanced'], default: 'basic' },
        { key: 'secret', label: 'secret', kind: 'secret', required: true, dependsOn: { mode: 'advanced' } },
      ],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 12, cols: 100 }, status: '' }
    const body = view.render(ctx).join('\n')

    expect(body).toContain('* required, ↳ changes visible fields')
    expect(body).toContain('mode ↳')
    ;(view as unknown as { focus: number }).focus = 0
    await view.onKey('?', ctx)

    const info = vi.mocked(app.push).mock.calls.at(-1)![0] as { render: FormView['render'] }
    const help = info.render(ctx).join('\n')
    expect(help).toContain('Affects fields')
    expect(help).toContain('secret')
  })
})

describe('FormView validation', () => {
  it('blocks submit when required field empty', async () => {
    const submit = vi.fn(async () => {})
    const view = new FormView({
      title: 't',
      fields: [{ key: 'name', label: 'name', kind: 'text', required: true }],
      onSubmit: submit,
    })
    const app = fakeApp()
    await view.onKey('enter', { app, size: { rows: 10, cols: 80 }, status: '' })
    expect(submit).not.toHaveBeenCalled()
    const status = (app as unknown as { _status: { text: string; kind: string }[] })._status
    expect(status[0]!.text).toMatch(/required/)
  })

  it('runs custom validator', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'n', label: 'n', kind: 'text', default: 'bad', validate: (v) => v === 'bad' ? 'no good' : undefined }],
      onSubmit: vi.fn(async () => {}),
    })
    const app = fakeApp()
    await view.onKey('enter', { app, size: { rows: 10, cols: 80 }, status: '' })
    const status = (app as unknown as { _status: { text: string; kind: string }[] })._status
    expect(status[0]!.text).toBe('no good')
  })

  it('shows explained API errors from submit handlers', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'name', label: 'name', kind: 'text', default: 'Fiona' }],
      onSubmit: async () => { throw new AdminApiError(403, 'dcr_disabled', {}) },
    })
    const app = fakeApp()

    await view.onKey('enter', { app, size: { rows: 10, cols: 80 }, status: '' })

    const status = (app as unknown as { _status: { text: string; kind: string }[] })._status
    expect(status[0]!.text).toContain('This zone does not support DCR')
    expect(status[0]!.text).not.toContain('HTTP 403')
  })

  it('skips hidden fields during rendering, navigation, and validation', async () => {
    const submit = vi.fn(async () => {})
    const view = new FormView({
      title: 't',
      fields: [
        { key: 'advanced', label: 'advanced', kind: 'bool', default: 'false' },
        { key: 'secret', label: 'secret', kind: 'text', required: true, visible: (values) => values.advanced === 'true' },
      ],
      onSubmit: submit,
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }

    expect(view.render(ctx).join('\n')).not.toContain('secret *')
    await view.onKey('down', ctx)
    expect((view as unknown as { focus: number }).focus).toBe(1)
    await view.onKey('enter', ctx)
    expect(submit).toHaveBeenCalledWith({ advanced: 'false', secret: '' }, expect.anything())

    ;(view as unknown as { submitting: boolean }).submitting = false
    ;(view as unknown as { focus: number }).focus = 0
    await view.onKey('enter', ctx)
    expect(view.values_().advanced).toBe('true')
    expect(view.render(ctx).join('\n')).toContain('secret *')
    await view.onKey('down', ctx)
    await view.onKey('enter', ctx)
    const status = (app as unknown as { _status: { text: string; kind: string }[] })._status
    expect(status.some((entry) => entry.text === 'secret is required')).toBe(true)
  })
})

describe('FormView secret', () => {
  it('masks by default and reveals with right arrow', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 's', label: 's', kind: 'secret', default: 'topsecret' }],
      onSubmit: async () => {},
    })
    const ctx = { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' }
    let lines = view.render(ctx).join('\n')
    expect(lines).toContain('••••')
    expect(lines).not.toContain('topsecret')
    await view.onKey('right', ctx)
    lines = view.render(ctx).join('\n')
    expect(lines).toContain('topsecret')
  })
})

describe('FormView list field', () => {
  it('passes raw csv to onSubmit', async () => {
    const submit = vi.fn(async () => {})
    const view = new FormView({
      title: 't',
      fields: [{ key: 'tags', label: 'tags', kind: 'list', default: 'a,b,c' }],
      onSubmit: submit,
    })
    await view.onKey('enter', { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })
    expect(submit).toHaveBeenCalledWith({ tags: 'a,b,c' }, expect.anything())
  })
})

describe('FormView picker fields', () => {
  it('opens focused field picker with right arrow and lets it set the value', async () => {
    const pick = vi.fn((_app: App, setValue: (value: string, label?: string) => void) => {
      setValue('picked-id', 'Payments API')
    })
    const view = new FormView({
      title: 't',
      fields: [{ key: 'application_id', label: 'application', kind: 'text', pick }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    await view.onKey('right', { app, size: { rows: 10, cols: 80 }, status: '' })
    expect(pick).toHaveBeenCalled()
    expect(view.values_().application_id).toBe('picked-id')
    expect(view.hints()).toContain('→:pick')
    const lines = view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')
    expect(lines).toContain('Payments API')
    expect(lines).toContain('id:hidden')
    expect(lines).not.toContain('picked-id')
  })

  it('reveals picker IDs only when requested', async () => {
    const view = new FormView({
      title: 't',
      fields: [{
        key: 'resource_id',
        label: 'resource',
        kind: 'text',
        default: 'res-1',
        pick: vi.fn(),
        resolve: async () => 'Payments API',
      }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    await view.init(app)
    await view.onKey('V', { app, size: { rows: 10, cols: 80 }, status: '' })
    const lines = view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')
    expect(lines).toContain('Payments API')
    expect(lines).toContain('res-1')
  })
})

describe('FormView file picker', () => {
  it('picks files under the current directory and rejects leaving it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caracal-form-file-'))
    dirs.push(root)
    mkdirSync(join(root, 'policies'))
    writeFileSync(join(root, 'policies', 'pipernet.rego'), 'package pipernet\n')
    const cwd = process.cwd()
    process.chdir(root)
    try {
      const view = new FormView({
        title: 'policy file',
        fields: [{ key: 'path', label: 'policy path', kind: 'file' }],
        onSubmit: async () => {},
      })
      const app = fakeApp()
      const ctx = { app, size: { rows: 8, cols: 120 }, status: '' }

      await view.onKey('right', ctx)
      const picker = vi.mocked(app.push).mock.calls.at(-1)![0] as { onKey: FormView['onKey']; render: FormView['render']; hints: () => string[] }
      expect(picker.hints()).toContain(':abs')
      await picker.onKey('?', ctx)
      expect(vi.mocked(app.push).mock.calls.some((call) => (call[0] as { title?: string }).title === 'info / File picker')).toBe(true)
      await picker.onKey('enter', ctx)
      await picker.onKey('enter', ctx)

      expect(view.values_().path).toBe(join(root, 'policies', 'pipernet.rego'))
      expect(app.pop).toHaveBeenCalled()

      await view.onKey('right', ctx)
      const second = vi.mocked(app.push).mock.calls.at(-1)![0] as { onKey: FormView['onKey'] }
      await second.onKey('left', ctx)
      expect(app.setStatus).toHaveBeenCalledWith('refusing to leave cwd; use : for absolute path', 'error')
    } finally {
      process.chdir(cwd)
    }
  })

  it('supports absolute file entry and rejects relative absolute prompts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caracal-form-abs-'))
    dirs.push(root)
    const policyPath = join(root, 'pipernet.rego')
    writeFileSync(policyPath, 'package pipernet\n')
    const view = new FormView({
      title: 'policy file',
      fields: [{ key: 'path', label: 'policy path', kind: 'file' }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 8, cols: 120 }, status: '' }

    await view.onKey('right', ctx)
    const picker = vi.mocked(app.push).mock.calls.at(-1)![0] as { onKey: FormView['onKey']; render: FormView['render']; hints: () => string[] }
    await picker.onKey(':', ctx)
    expect(picker.hints()).toContain('enter:open')
    await picker.onKey('relative.rego', ctx)
    await picker.onKey('enter', ctx)
    expect(app.setStatus).toHaveBeenCalledWith('absolute path required (no ~ expansion)', 'error')

    await picker.onKey(':', ctx)
    await picker.onKey(policyPath, ctx)
    expect(picker.render(ctx).join('\n')).toContain(policyPath)
    await picker.onKey('enter', ctx)
    expect(view.values_().path).toBe(policyPath)
    expect(app.pop).toHaveBeenCalled()
  })
})

describe('FormView esc cancels', () => {
  it('pops the app and calls onCancel', async () => {
    const cancel = vi.fn()
    const view = new FormView({ title: 't', fields: [], onSubmit: async () => {}, onCancel: cancel })
    const app = fakeApp()
    await view.onKey('esc', { app, size: { rows: 10, cols: 80 }, status: '' })
    expect(cancel).toHaveBeenCalled()
    expect(app.pop).toHaveBeenCalled()
  })
})

describe('FormView dispose', () => {
  it('aborts the controller', () => {
    const view = new FormView({ title: 't', fields: [], onSubmit: async () => {} })
    expect(view.abort.signal.aborted).toBe(false)
    view.dispose()
    expect(view.abort.signal.aborted).toBe(true)
  })
})
