import { BaseAdapter } from './adapters/base';
import { HookRegistry, ScopeRef } from './hooks';
import { ToolOperations, ToolScope } from './tools';

// ---------------------------------------------------------------------------
// ScopeContext
// ---------------------------------------------------------------------------

export class ScopeContext implements ToolScope {
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;

  /** @internal */
  readonly _adapter: BaseAdapter;
  /** @internal */
  readonly _hooks: HookRegistry;

  private _tools?: ToolOperations;

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
