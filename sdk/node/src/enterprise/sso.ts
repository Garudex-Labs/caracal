/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SSO Extension (Enterprise Stub).
 * PROPRIETARY LICENSE — not covered by AGPLv3.
 */

import { CaracalExtension } from '../extensions';
import { HookRegistry } from '../hooks';
import { EnterpriseFeatureRequired } from './exceptions';

export class SSOExtension implements CaracalExtension {
  readonly name = 'sso';
  readonly version = '0.1.0';

  constructor(private readonly options?: { provider?: string }) {}

  install(hooks: HookRegistry): void {
    hooks.onBeforeRequest(() => {
      throw new EnterpriseFeatureRequired('SSO Token Injection');
    });
  }

  authenticate(_credentials: Record<string, unknown>): Record<string, unknown> {
    throw new EnterpriseFeatureRequired(`SSO Authentication (${this.options?.provider ?? 'oidc'})`);
  }

  getUserInfo(_token: string): Record<string, unknown> {
    throw new EnterpriseFeatureRequired('SSO User Info');
  }
}
