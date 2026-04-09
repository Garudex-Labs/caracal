/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK Mandate Operations.
 */

import { SDKRequest } from './adapters/base';
import { ScopeContext } from './context';

export class MandateOperations {
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

  async create(options: {
    principalId: string;
    allowedOperations: string[];
    expiresIn: number;
    intent?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      principal_id: options.principalId,
      allowed_operations: options.allowedOperations,
      expires_in: options.expiresIn,
    };
    if (options.intent) body.intent = options.intent;
    if (options.metadata) body.metadata = options.metadata;
    return this.exec(this.buildReq('POST', '/mandates', body));
  }

  async validate(options: {
    mandateId: string;
    requestedAction: string;
    requestedResource: string;
  }): Promise<unknown> {
    return this.exec(this.buildReq('POST', `/mandates/${options.mandateId}/validate`, {
      requested_action: options.requestedAction,
      requested_resource: options.requestedResource,
    }));
  }

  async revoke(options: {
    mandateId: string;
    revokerId: string;
    reason: string;
    cascade?: boolean;
  }): Promise<unknown> {
    return this.exec(this.buildReq('POST', `/mandates/${options.mandateId}/revoke`, {
      revoker_id: options.revokerId,
      reason: options.reason,
      cascade: options.cascade ?? true,
    }));
  }

  async get(mandateId: string): Promise<unknown> {
    return this.exec(this.buildReq('GET', `/mandates/${mandateId}`));
  }

  async list(options?: { principalId?: string; limit?: number }): Promise<unknown> {
    const params: Record<string, unknown> = { limit: options?.limit ?? 100 };
    if (options?.principalId) params.principal_id = options.principalId;
    return this.exec(this.buildReq('GET', '/mandates', undefined, params));
  }
}
