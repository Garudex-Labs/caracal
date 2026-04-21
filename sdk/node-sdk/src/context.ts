/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK Context & Scope Management.
 * Implements workspace scope hierarchy.
 */

import { BaseAdapter, SDKRequest } from './adapters/base';
import { HookRegistry, ScopeRef, StateSnapshot } from './hooks';
import { ToolOperations } from './tools';

// ---------------------------------------------------------------------------
// ScopeContext
// ---------------------------------------------------------------------------

export class ScopeContext {
  readonly workspaceId?: string;

  /** @internal */
  readonly _adapter: BaseAdapter;
  /** @internal */
  readonly _hooks: HookRegistry;

  private _tools?: ToolOperations;

  constructor(options: {
    adapter: BaseAdapter;
    hooks: HookRegistry;
    workspaceId?: string;
  }) {
    this._adapter = options.adapter;
    this._hooks = options.hooks;
    this.workspaceId = options.workspaceId;
  }

  /** HTTP headers encoding the current scope. */
  scopeHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.workspaceId) h['X-Caracal-Workspace-ID'] = this.workspaceId;
    return h;
  }

  /** Lightweight ref for hook callbacks. */
  toScopeRef(): ScopeRef {
    return {
      workspaceId: this.workspaceId,
    };
  }

  // -- Resource accessors (lazy) -------------------------------------------

  get tools(): ToolOperations {
    if (!this._tools) this._tools = new ToolOperations(this);
    return this._tools;
  }
}

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

export class ContextManager {
  private _current: ScopeContext | null = null;

  constructor(
    private readonly adapter: BaseAdapter,
    private readonly hooks: HookRegistry,
  ) {}

  get current(): ScopeContext | null {
    return this._current;
  }

  /** Activate a new scope. Fires `onContextSwitch`. */
  checkout(options?: {
    workspaceId?: string;
  }): ScopeContext {
    const oldRef = this._current?.toScopeRef() ?? null;

    const ctx = new ScopeContext({
      adapter: this.adapter,
      hooks: this.hooks,
      workspaceId: options?.workspaceId,
    });

    this._current = ctx;
    this.hooks.fireContextSwitch(oldRef, ctx.toScopeRef());
    this.hooks.fireStateChange({
      workspaceId: options?.workspaceId,
    });

    return ctx;
  }
}
