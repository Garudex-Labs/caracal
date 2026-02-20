/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Analytics Extension (Enterprise Stub).
 * PROPRIETARY LICENSE — not covered by AGPLv3.
 */

import { CaracalExtension } from '../extensions';
import { HookRegistry } from '../hooks';
import { EnterpriseFeatureRequired } from './exceptions';

export class AnalyticsExtension implements CaracalExtension {
  readonly name = 'analytics';
  readonly version = '0.1.0';

  constructor(private readonly options?: { exportInterval?: number }) {}

  install(hooks: HookRegistry): void {
    hooks.onAfterResponse(() => {
      throw new EnterpriseFeatureRequired('Analytics Metrics Collection');
    });
  }

  export(_format?: string): unknown {
    throw new EnterpriseFeatureRequired('Analytics Export');
  }

  getDashboardUrl(): string {
    throw new EnterpriseFeatureRequired('Analytics Dashboard');
  }
}
