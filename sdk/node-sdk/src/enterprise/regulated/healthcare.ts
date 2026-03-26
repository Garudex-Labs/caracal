/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Healthcare Regulated Industry Extension (Enterprise Stub).
 * PROPRIETARY LICENSE — not covered by AGPLv3.
 */

import { CaracalExtension } from '../../extensions';
import { HookRegistry } from '../../hooks';
import { EnterpriseFeatureRequired } from '../exceptions';

export class HealthcareExtension implements CaracalExtension {
  readonly name = 'regulated-healthcare';
  readonly version = '0.1.0';

  install(hooks: HookRegistry): void {
    hooks.onBeforeRequest(() => {
      throw new EnterpriseFeatureRequired('Healthcare PHI Protection');
    });
  }
}
