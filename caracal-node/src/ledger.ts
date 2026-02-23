/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK Ledger Query Interface.
 */

import { SDKRequest } from './adapters/base';
import { ScopeContext } from './context';

export class LedgerOperations {
  constructor(private readonly scope: ScopeContext) {}

  private buildReq(method: string, path: string, body?: Record<string, unknown>, params?: Record<string, unknown>): SDKRequest {
    return { method, path, headers: { ...this.scope.scopeHeaders() }, body, params };
  }

  private async exec(req: SDKRequest): Promise<unknown> {
    const scoped = await this.scope._hooks.fireBeforeRequest(req, this.scope.toScopeRef());
    try {
      const res = await this.scope._adapter.send(scoped);
      this.scope._hooks.fireAfterResponse(res, this.scope.toScopeRef());
      return res.body;
    } catch (e) {
      this.scope._hooks.fireError(e as Error);
      throw e;
    }
  }

  async query(options?: {
    principalId?: string;
    mandateId?: string;
    eventType?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
    offset?: number;
  }): Promise<unknown> {
    const params: Record<string, unknown> = {
      limit: options?.limit ?? 100,
      offset: options?.offset ?? 0,
    };
    if (options?.principalId) params.principal_id = options.principalId;
    if (options?.mandateId) params.mandate_id = options.mandateId;
    if (options?.eventType) params.event_type = options.eventType;
    if (options?.startTime) params.start_time = options.startTime;
    if (options?.endTime) params.end_time = options.endTime;
    return this.exec(this.buildReq('GET', '/ledger/events', undefined, params));
  }

  async getEntry(entryId: string): Promise<unknown> {
    return this.exec(this.buildReq('GET', `/ledger/entries/${entryId}`));
  }

  async getChain(mandateId: string): Promise<unknown> {
    return this.exec(this.buildReq('GET', `/ledger/chain/${mandateId}`));
  }

  async verifyIntegrity(entryId: string): Promise<unknown> {
    return this.exec(this.buildReq('GET', `/ledger/verify/${entryId}`));
  }
}
