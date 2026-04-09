/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK Principal Operations.
 */

import { SDKRequest } from './adapters/base';
import { ScopeContext } from './context';

export class PrincipalOperations {
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

  async list(options?: { limit?: number; offset?: number }): Promise<unknown> {
    return this.exec(this.buildReq('GET', '/principals', undefined, { limit: options?.limit ?? 100, offset: options?.offset ?? 0 }));
  }

  async get(principalId: string): Promise<unknown> {
    return this.exec(this.buildReq('GET', `/principals/${principalId}`));
  }

  async create(options: { name: string; owner: string; metadata?: Record<string, unknown> }): Promise<unknown> {
    const body: Record<string, unknown> = { name: options.name, owner: options.owner };
    if (options.metadata) body.metadata = options.metadata;
    return this.exec(this.buildReq('POST', '/principals', body));
  }

  async update(principalId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.exec(this.buildReq('PATCH', `/principals/${principalId}`, data));
  }

  async delete(principalId: string): Promise<unknown> {
    return this.exec(this.buildReq('DELETE', `/principals/${principalId}`));
  }

  async delegateAuthority(options: {
    sourcePrincipalId: string;
    targetPrincipalId: string;
    delegationType?: string;
    contextTags?: string[];
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      target_principal_id: options.targetPrincipalId,
      delegation_type: options.delegationType ?? 'directed',
    };
    if (options.contextTags) body.context_tags = options.contextTags;
    return this.exec(this.buildReq('POST', `/principals/${options.sourcePrincipalId}/delegate`, body));
  }
}
