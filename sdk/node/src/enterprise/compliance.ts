/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Compliance Extension (Enterprise Stub).
 * PROPRIETARY LICENSE — not covered by AGPLv3.
 */

import { CaracalExtension } from '../extensions';
import { HookRegistry } from '../hooks';
import { EnterpriseFeatureRequired } from './exceptions';

export class ComplianceExtension implements CaracalExtension {
  readonly name = 'compliance';
  readonly version = '0.1.0';

  constructor(private readonly options?: { standard?: string; autoReport?: boolean }) {}

  install(hooks: HookRegistry): void {
    if (this.options?.autoReport) {
      hooks.onStateChange(() => {
        throw new EnterpriseFeatureRequired('Compliance Auto-Report');
      });
    }
    hooks.onAfterResponse(() => {
      throw new EnterpriseFeatureRequired('Compliance Audit');
    });
  }

  generateReport(_timeRange: [string, string]): Uint8Array {
    throw new EnterpriseFeatureRequired(`Compliance Report (${this.options?.standard ?? 'soc2'})`);
  }

  runComplianceCheck(): Record<string, unknown> {
    throw new EnterpriseFeatureRequired('Compliance Check');
  }
}
