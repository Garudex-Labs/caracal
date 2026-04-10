/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK Delegation Operations — Graph-Based Model.
 */

import { SDKRequest } from './adapters/base';
import { ScopeContext } from './context';
import { requireLegacyResourceApi } from './runtime_surface';

export class DelegationOperations {
  constructor(private readonly scope: ScopeContext) {}

  private buildReq(method: string, path: string, body?: Record<string, unknown>, params?: Record<string, unknown>): SDKRequest {
    requireLegacyResourceApi('DelegationOperations', '/delegations');
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

  /** Create a delegation edge from source mandate to target subject. */
  async create(options: {
    sourceMandateId: string;
    childSubjectId: string;
    resourceScope: string[];
    actionScope: string[];
    validitySeconds: number;
    contextTags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      source_mandate_id: options.sourceMandateId,
      child_subject_id: options.childSubjectId,
      resource_scope: options.resourceScope,
      action_scope: options.actionScope,
      validity_seconds: options.validitySeconds,
    };
    if (options.contextTags) body.context_tags = options.contextTags;
    if (options.metadata) body.metadata = options.metadata;
    return this.exec(this.buildReq('POST', '/delegations', body));
  }

  /** Generate a delegation token from source principal to target principal. */
  async getToken(options: {
    sourcePrincipalId: string;
    targetPrincipalId: string;
    expirationSeconds?: number;
    allowedOperations?: string[];
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      source_principal_id: options.sourcePrincipalId,
      target_principal_id: options.targetPrincipalId,
      expiration_seconds: options.expirationSeconds ?? 86400,
    };
    if (options.allowedOperations) body.allowed_operations = options.allowedOperations;
    return this.exec(this.buildReq('POST', '/delegations/token', body));
  }

  /** Peer-to-peer delegation between principals of the same type. */
  async peerDelegate(options: {
    sourceMandateId: string;
    targetSubjectId: string;
    resourceScope: string[];
    actionScope: string[];
    validitySeconds: number;
    contextTags?: string[];
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      source_mandate_id: options.sourceMandateId,
      target_subject_id: options.targetSubjectId,
      resource_scope: options.resourceScope,
      action_scope: options.actionScope,
      validity_seconds: options.validitySeconds,
    };
    if (options.contextTags) body.context_tags = options.contextTags;
    return this.exec(this.buildReq('POST', '/delegations/peer', body));
  }

  /** Get delegation graph for a principal (all connected edges). */
  async getGraph(principalId: string): Promise<unknown> {
    return this.exec(this.buildReq('GET', `/delegations/graph/${principalId}`));
  }

  /** Revoke a specific delegation edge. */
  async revokeEdge(edgeId: string, cascade: boolean = true): Promise<unknown> {
    return this.exec(this.buildReq('DELETE', `/delegations/edges/${edgeId}`, undefined, { cascade }));
  }
}
