/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK Context & Scope Management.
 * Implements Organization → Workspace → Project scope hierarchy.
 */

import { BaseAdapter, SDKRequest } from './adapters/base';
import { HookRegistry, ScopeRef, StateSnapshot } from './hooks';
import { PrincipalOperations } from './principals';
import { MandateOperations } from './mandates';
import { DelegationOperations } from './delegation';
import { LedgerOperations } from './ledger';

// ---------------------------------------------------------------------------
// ScopeContext
// ---------------------------------------------------------------------------

export class ScopeContext {
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;

  /** @internal */
  readonly _adapter: BaseAdapter;
  /** @internal */
  readonly _hooks: HookRegistry;

  private _principals?: PrincipalOperations;
  private _mandates?: MandateOperations;
  private _delegation?: DelegationOperations;
  private _ledger?: LedgerOperations;

  constructor(options: {
    adapter: BaseAdapter;
    hooks: HookRegistry;
    organizationId?: string;
    workspaceId?: string;
    projectId?: string;
  }) {
    this._adapter = options.adapter;
    this._hooks = options.hooks;
    this.organizationId = options.organizationId;
    this.workspaceId = options.workspaceId;
    this.projectId = options.projectId;
  }

  /** HTTP headers encoding the current scope. */
  scopeHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.organizationId) h['X-Caracal-Org-ID'] = this.organizationId;
    if (this.workspaceId) h['X-Caracal-Workspace-ID'] = this.workspaceId;
    if (this.projectId) h['X-Caracal-Project-ID'] = this.projectId;
    return h;
  }

  /** Lightweight ref for hook callbacks. */
  toScopeRef(): ScopeRef {
    return {
      organizationId: this.organizationId,
      workspaceId: this.workspaceId,
      projectId: this.projectId,
    };
  }

  // -- Resource accessors (lazy) -------------------------------------------

  get principals(): PrincipalOperations {
    if (!this._principals) this._principals = new PrincipalOperations(this);
    return this._principals;
  }

  get mandates(): MandateOperations {
    if (!this._mandates) this._mandates = new MandateOperations(this);
    return this._mandates;
  }

  get delegation(): DelegationOperations {
    if (!this._delegation) this._delegation = new DelegationOperations(this);
    return this._delegation;
  }

  get ledger(): LedgerOperations {
    if (!this._ledger) this._ledger = new LedgerOperations(this);
    return this._ledger;
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
    organizationId?: string;
    workspaceId?: string;
    projectId?: string;
  }): ScopeContext {
    const oldRef = this._current?.toScopeRef() ?? null;

    const ctx = new ScopeContext({
      adapter: this.adapter,
      hooks: this.hooks,
      organizationId: options?.organizationId,
      workspaceId: options?.workspaceId,
      projectId: options?.projectId,
    });

    this._current = ctx;
    this.hooks.fireContextSwitch(oldRef, ctx.toScopeRef());
    this.hooks.fireStateChange({
      organizationId: options?.organizationId,
      workspaceId: options?.workspaceId,
      projectId: options?.projectId,
    });

    return ctx;
  }
}
