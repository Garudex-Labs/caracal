/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Sync Extension (Enterprise Stub).
 * PROPRIETARY LICENSE — not covered by AGPLv3.
 */

import { CaracalExtension } from '../extensions';
import { HookRegistry } from '../hooks';
import { EnterpriseFeatureRequired } from './exceptions';

export class SyncExtension implements CaracalExtension {
  readonly name = 'sync';
  readonly version = '0.1.0';

  constructor(private readonly options?: { syncUrl?: string; interval?: number }) {}

  install(hooks: HookRegistry): void {
    hooks.onStateChange(() => {
      throw new EnterpriseFeatureRequired('State Sync');
    });
  }

  forceSync(): Record<string, unknown> {
    throw new EnterpriseFeatureRequired('Force Sync');
  }

  getSyncStatus(): Record<string, unknown> {
    throw new EnterpriseFeatureRequired('Sync Status');
  }
}
