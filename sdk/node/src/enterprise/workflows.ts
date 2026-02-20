/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Workflows Extension (Enterprise Stub).
 * PROPRIETARY LICENSE — not covered by AGPLv3.
 */

import { CaracalExtension } from '../extensions';
import { HookRegistry } from '../hooks';
import { EnterpriseFeatureRequired } from './exceptions';

export class WorkflowsExtension implements CaracalExtension {
  readonly name = 'workflows';
  readonly version = '0.1.0';

  install(hooks: HookRegistry): void {
    hooks.onStateChange(() => {
      throw new EnterpriseFeatureRequired('Workflow Automation');
    });
  }

  registerWorkflow(_name: string, _trigger: string, _action: unknown): void {
    throw new EnterpriseFeatureRequired('Workflow Registration');
  }
}
