/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * License Extension (Enterprise Stub).
 * PROPRIETARY LICENSE — not covered by AGPLv3.
 */

import { CaracalExtension } from '../extensions';
import { HookRegistry } from '../hooks';
import { EnterpriseFeatureRequired } from './exceptions';

export class LicenseExtension implements CaracalExtension {
  readonly name = 'license';
  readonly version = '0.1.0';

  constructor(private readonly _licenseKey?: string) {}

  install(hooks: HookRegistry): void {
    hooks.onInitialize(() => {
      throw new EnterpriseFeatureRequired('License Validation');
    });
  }

  validate(): Record<string, unknown> {
    throw new EnterpriseFeatureRequired('License Validation');
  }

  getEntitlements(): unknown[] {
    throw new EnterpriseFeatureRequired('License Entitlements');
  }
}
