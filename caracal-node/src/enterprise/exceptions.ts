/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Enterprise feature exception.
 * PROPRIETARY LICENSE — not covered by AGPLv3.
 */

export class EnterpriseFeatureRequired extends Error {
  readonly feature: string;
  readonly upgradeUrl = 'https://garudexlabs.com';

  constructor(feature: string, message?: string) {
    super(
      message ?? `${feature} requires Caracal Enterprise. Visit https://garudexlabs.com for licensing.`,
    );
    this.name = 'EnterpriseFeatureRequired';
    this.feature = feature;
  }
}
