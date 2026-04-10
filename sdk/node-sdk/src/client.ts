/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal SDK Client & Builder.
 */

import { BaseAdapter } from './adapters/base';
import { HttpAdapter } from './adapters/http';
import { CaracalExtension } from './extensions';
import { HookRegistry } from './hooks';
import { ContextManager, ScopeContext } from './context';
import { PrincipalOperations } from './principals';
import { MandateOperations } from './mandates';
import { DelegationOperations } from './delegation';
import { LedgerOperations } from './ledger';
import { ToolOperations } from './tools';
import { SDKConfigurationError } from './errors';
import { resolveSdkBaseUrl } from './ais';

const DEFAULT_BASE_URL = (() => {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return resolveSdkBaseUrl(proc?.env ?? {});
})();

export { SDKConfigurationError } from './errors';

// ---------------------------------------------------------------------------
// CaracalClient
// ---------------------------------------------------------------------------

export class CaracalClient {
  /** @internal */
  readonly _hooks: HookRegistry;
  private readonly _adapter: BaseAdapter;
  private readonly _contextManager: ContextManager;
  private readonly _defaultScope: ScopeContext;
  private readonly _extensions: CaracalExtension[] = [];

  constructor(options: {
    apiKey?: string;
    baseUrl?: string;
    adapter?: BaseAdapter;
  }) {
    if (!options.apiKey && !options.adapter) {
      throw new SDKConfigurationError(
        'CaracalClient requires either apiKey or a custom adapter.',
      );
    }

    this._hooks = new HookRegistry();
    this._adapter = options.adapter ?? new HttpAdapter({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: options.apiKey,
    });

    this._contextManager = new ContextManager(this._adapter, this._hooks);
    this._defaultScope = new ScopeContext({
      adapter: this._adapter,
      hooks: this._hooks,
    });
  }

  /** Register an extension plugin. Returns `this` for chaining. */
  use(extension: CaracalExtension): this {
    extension.install(this._hooks);
    this._extensions.push(extension);
    return this;
  }

  /** Context manager for scope checkout. */
  get context(): ContextManager {
    return this._contextManager;
  }

  /** Principal operations (default scope). */
  get principals(): PrincipalOperations {
    return this._defaultScope.principals;
  }

  /** Mandate operations (default scope). */
  get mandates(): MandateOperations {
    return this._defaultScope.mandates;
  }

  /** Delegation operations (default scope). */
  get delegation(): DelegationOperations {
    return this._defaultScope.delegation;
  }

  /** Ledger operations (default scope). */
  get ledger(): LedgerOperations {
    return this._defaultScope.ledger;
  }

  /** Tool call operations (default scope). */
  get tools(): ToolOperations {
    return this._defaultScope.tools;
  }

  /** Release all resources. */
  close(): void {
    this._adapter.close();
  }
}

// ---------------------------------------------------------------------------
// CaracalBuilder
// ---------------------------------------------------------------------------

export class CaracalBuilder {
  private _apiKey?: string;
  private _baseUrl = DEFAULT_BASE_URL;
  private _adapter?: BaseAdapter;
  private _extensions: CaracalExtension[] = [];

  setApiKey(key: string): this {
    this._apiKey = key;
    return this;
  }

  setBaseUrl(url: string): this {
    this._baseUrl = url;
    return this;
  }

  setTransport(adapter: BaseAdapter): this {
    this._adapter = adapter;
    return this;
  }

  use(extension: CaracalExtension): this {
    this._extensions.push(extension);
    return this;
  }

  build(): CaracalClient {
    if (!this._apiKey && !this._adapter) {
      throw new SDKConfigurationError(
        'CaracalBuilder.build() requires either setApiKey() or setTransport().',
      );
    }

    const client = new CaracalClient({
      apiKey: this._apiKey,
      baseUrl: this._baseUrl,
      adapter: this._adapter,
    });

    for (const ext of this._extensions) {
      client.use(ext);
    }

    client._hooks.fireInitialize();
    return client;
  }
}
