/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Tests for SDK Hooks, Extensions, Client, Context.
 */

import { HookRegistry, ScopeRef } from '../src/hooks';
import { CaracalExtension } from '../src/extensions';
import { CaracalClient, CaracalBuilder, SDKConfigurationError } from '../src/client';
import { MockAdapter } from '../src/adapters/mock';
import { SDKRequest, SDKResponse } from '../src/adapters/base';

// ---------------------------------------------------------------------------
// HookRegistry tests
// ---------------------------------------------------------------------------

describe('HookRegistry', () => {
  let registry: HookRegistry;
  beforeEach(() => { registry = new HookRegistry(); });

  test('fire initialize with no callbacks', () => {
    expect(() => registry.fireInitialize()).not.toThrow();
  });

  test('fire initialize invokes callbacks in order', () => {
    const order: string[] = [];
    registry.onInitialize(() => order.push('first'));
    registry.onInitialize(() => order.push('second'));
    registry.fireInitialize();
    expect(order).toEqual(['first', 'second']);
  });

  test('before request pipeline mutates request', async () => {
    registry.onBeforeRequest((req, _scope) => {
      return { ...req, headers: { ...req.headers, 'X-Step': 'A' } };
    });
    registry.onBeforeRequest((req, _scope) => {
      return { ...req, headers: { ...req.headers, 'X-Step': req.headers['X-Step'] + ',B' } };
    });

    const req: SDKRequest = { method: 'POST', path: '/mcp/tool/call', headers: {} };
    const result = await registry.fireBeforeRequest(req, {});
    expect(result.headers['X-Step']).toBe('A,B');
  });

  test('after response fires callbacks', () => {
    const seen: number[] = [];
    registry.onAfterResponse((res) => seen.push(res.statusCode));
    const res: SDKResponse = { statusCode: 200, headers: {}, body: null, elapsedMs: 0 };
    registry.fireAfterResponse(res, {});
    expect(seen).toEqual([200]);
  });

  test('error in error hook does not recurse', () => {
    registry.onError(() => { throw new Error('hook crash'); });
    expect(() => registry.fireError(new Error('original'))).not.toThrow();
  });

  test('context switch fires with from/to', () => {
    const switches: [ScopeRef | null, ScopeRef][] = [];
    registry.onContextSwitch((from, to) => switches.push([from, to]));
    registry.fireContextSwitch(null, { workspaceId: 'ws_1' });
    expect(switches).toEqual([[null, { workspaceId: 'ws_1' }]]);
  });
});

// ---------------------------------------------------------------------------
// CaracalExtension tests
// ---------------------------------------------------------------------------

describe('CaracalExtension', () => {
  test('concrete extension installs hooks', () => {
    const registry = new HookRegistry();

    const ext: CaracalExtension = {
      name: 'demo',
      version: '0.1.0',
      install(hooks) {
        hooks.onInitialize(() => {});
        hooks.onBeforeRequest((req) => {
          return { ...req, headers: { ...req.headers, 'X-Demo': 'true' } };
        });
      },
    };

    ext.install(registry);
    registry.fireInitialize(); // should not throw
  });
});

// ---------------------------------------------------------------------------
// CaracalClient tests
// ---------------------------------------------------------------------------

describe('CaracalClient', () => {
  test('throws without apiKey or adapter', () => {
    expect(() => new CaracalClient({})).toThrow(SDKConfigurationError);
  });

  test('creates with mock adapter', () => {
    const adapter = new MockAdapter();
    const client = new CaracalClient({ adapter });
    expect(client.tools).toBeDefined();
    client.close();
  });

  test('.use() chains extensions', () => {
    const adapter = new MockAdapter();
    const client = new CaracalClient({ adapter });

    const ext: CaracalExtension = {
      name: 'test-ext',
      version: '1.0.0',
      install: () => {},
    };

    const result = client.use(ext);
    expect(result).toBe(client); // chaining
  });

  test('context.checkout creates scoped context', () => {
    const adapter = new MockAdapter();
    const client = new CaracalClient({ adapter });

    const ctx = client.context.checkout({
      workspaceId: 'ws_1',
    });

    expect(ctx.workspaceId).toBe('ws_1');
    expect(ctx.tools).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CaracalBuilder tests
// ---------------------------------------------------------------------------

describe('CaracalBuilder', () => {
  test('throws without apiKey or transport', () => {
    expect(() => new CaracalBuilder().build()).toThrow(SDKConfigurationError);
  });

  test('builds with mock adapter', () => {
    const adapter = new MockAdapter();
    const client = new CaracalBuilder().setTransport(adapter).build();
    expect(client.tools).toBeDefined();
    client.close();
  });

  test('installs extensions and fires initialize', () => {
    const initialized: string[] = [];
    const adapter = new MockAdapter();

    const ext: CaracalExtension = {
      name: 'builder-ext',
      version: '1.0.0',
      install(hooks) {
        hooks.onInitialize(() => initialized.push('init'));
      },
    };

    new CaracalBuilder().setTransport(adapter).use(ext).build();
    expect(initialized).toEqual(['init']);
  });
});

// ---------------------------------------------------------------------------
// MockAdapter tests
// ---------------------------------------------------------------------------

describe('MockAdapter', () => {
  test('returns 404 for unmocked routes', async () => {
    const adapter = new MockAdapter();
    const res = await adapter.send({ method: 'GET', path: '/unknown', headers: {} });
    expect(res.statusCode).toBe(404);
  });

  test('returns mocked response', async () => {
    const adapter = new MockAdapter();
    adapter.mock('POST', '/mcp/tool/call', {
      statusCode: 200,
      headers: {},
      body: { success: true, result: { ok: true } },
      elapsedMs: 0,
    });

    const res = await adapter.send({ method: 'POST', path: '/mcp/tool/call', headers: {} });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, result: { ok: true } });
  });

  test('records sent requests', async () => {
    const adapter = new MockAdapter();
    await adapter.send({
      method: 'POST',
      path: '/mcp/tool/call',
      headers: {},
      body: { toolId: 'provider:demo:resource:jobs:action:run' },
    });
    expect(adapter.sentRequests).toHaveLength(1);
    expect(adapter.sentRequests[0].path).toBe('/mcp/tool/call');
  });
});

// ---------------------------------------------------------------------------
// ScopeContext tests
// ---------------------------------------------------------------------------

describe('ScopeContext', () => {
  test('injects scope headers', () => {
    const adapter = new MockAdapter();
    const hooks = new HookRegistry();
    const { ScopeContext } = require('../src/context');

    const ctx = new ScopeContext({
      adapter,
      hooks,
      workspaceId: 'ws_1',
    });

    expect(ctx.scopeHeaders()).toEqual({
      'X-Caracal-Workspace-ID': 'ws_1',
    });
  });

  test('tools.call sends scoped request', async () => {
    const adapter = new MockAdapter();
    adapter.mock('POST', '/mcp/tool/call', {
      statusCode: 200,
      headers: {},
      body: { success: true, result: { ok: true } },
      elapsedMs: 0,
    });

    const hooks = new HookRegistry();
    const { ScopeContext } = require('../src/context');

    const ctx = new ScopeContext({
      adapter,
      hooks,
      workspaceId: 'ws_1',
    });

    const result = await ctx.tools.call({
      toolId: 'provider:demo:resource:jobs:action:run',
      toolArgs: { job: 'example' },
    });
    expect(result).toEqual({ success: true, result: { ok: true } });

    const sent = adapter.sentRequests;
    expect(sent[0].headers['X-Caracal-Workspace-ID']).toBe('ws_1');
    expect(sent[0].path).toBe('/mcp/tool/call');
  });

  test('scope context does not expose legacy resource accessors', () => {
    const adapter = new MockAdapter();
    const hooks = new HookRegistry();
    const { ScopeContext } = require('../src/context');

    const ctx = new ScopeContext({
      adapter,
      hooks,
      workspaceId: 'ws_1',
    });

    expect(Object.prototype.hasOwnProperty.call(ctx, 'principals')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'mandates')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'delegation')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'ledger')).toBe(false);
  });

  test('tools.call rejects metadata keys outside correlation surface', async () => {
    const adapter = new MockAdapter();
    const hooks = new HookRegistry();
    const { ScopeContext } = require('../src/context');

    const ctx = new ScopeContext({ adapter, hooks });

    await expect(
      ctx.tools.call({
        toolId: 'provider:demo:resource:jobs:action:run',
        metadata: { workspace_name: 'ws-1' },
      }),
    ).rejects.toThrow('metadata supports correlation keys only');
  });

  test('tools.call blocks caller spoofing fields', async () => {
    const adapter = new MockAdapter();
    const hooks = new HookRegistry();
    const { ScopeContext } = require('../src/context');

    const ctx = new ScopeContext({ adapter, hooks });

    await expect(
      ctx.tools.call({
        toolId: 'provider:demo:resource:jobs:action:run',
        metadata: { principal_id: 'spoofed' },
      }),
    ).rejects.toThrow('Caller identity fields are not allowed in tool call metadata');

    await expect(
      ctx.tools.call({
        toolId: 'provider:demo:resource:jobs:action:run',
        toolArgs: { task_token_claims: {} },
      }),
    ).rejects.toThrow('Caller identity fields are not allowed in toolArgs');

    await expect(
      ctx.tools.call({
        toolId: 'provider:demo:resource:jobs:action:run',
        metadata: { mandate_id: 'spoofed' },
      }),
    ).rejects.toThrow('Caller identity fields are not allowed in tool call metadata');

    await expect(
      ctx.tools.call({
        toolId: 'provider:demo:resource:jobs:action:run',
        metadata: { policy_id: 'spoofed' },
      }),
    ).rejects.toThrow('Caller identity fields are not allowed in tool call metadata');

    await expect(
      ctx.tools.call({
        toolId: 'provider:demo:resource:jobs:action:run',
        toolArgs: { resolved_mandate_id: 'spoofed' },
      }),
    ).rejects.toThrow('Caller identity fields are not allowed in toolArgs');

    await expect(
      ctx.tools.call({
        toolId: 'provider:demo:resource:jobs:action:run',
        toolArgs: { policy_id: 'spoofed' },
      }),
    ).rejects.toThrow('Caller identity fields are not allowed in toolArgs');
  });
});
