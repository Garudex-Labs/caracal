/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Tests for Enterprise Extension Stubs.
 */

import { EnterpriseFeatureRequired } from '../src/enterprise/exceptions';
import { ComplianceExtension } from '../src/enterprise/compliance';
import { AnalyticsExtension } from '../src/enterprise/analytics';
import { WorkflowsExtension } from '../src/enterprise/workflows';
import { HealthcareExtension } from '../src/enterprise/regulated/healthcare';
import { FinanceExtension } from '../src/enterprise/regulated/finance';
import { HookRegistry } from '../src/hooks';

describe('Enterprise Stubs', () => {
  test('EnterpriseFeatureRequired has correct fields', () => {
    const err = new EnterpriseFeatureRequired('SSO');
    expect(err.name).toBe('EnterpriseFeatureRequired');
    expect(err.feature).toBe('SSO');
    expect(err.message).toContain('Caracal Enterprise');
  });

  test('ComplianceExtension.generateReport throws', () => {
    const ext = new ComplianceExtension({ standard: 'soc2' });
    expect(() => ext.generateReport(['2026-01-01', '2026-02-01'])).toThrow(EnterpriseFeatureRequired);
  });

  test('ComplianceExtension.runComplianceCheck throws', () => {
    const ext = new ComplianceExtension();
    expect(() => ext.runComplianceCheck()).toThrow(EnterpriseFeatureRequired);
  });

  test('AnalyticsExtension.export throws', () => {
    const ext = new AnalyticsExtension();
    expect(() => ext.export()).toThrow(EnterpriseFeatureRequired);
  });

  test('WorkflowsExtension.registerWorkflow throws', () => {
    const ext = new WorkflowsExtension();
    expect(() => ext.registerWorkflow('wf1', 'event', {})).toThrow(EnterpriseFeatureRequired);
  });

  test('All enterprise extensions implement CaracalExtension', () => {
    const hooks = new HookRegistry();
    const extensions = [
      new ComplianceExtension(),
      new AnalyticsExtension(),
      new WorkflowsExtension(),
      new HealthcareExtension(),
      new FinanceExtension(),
    ];

    for (const ext of extensions) {
      expect(ext.name).toBeDefined();
      expect(ext.version).toBeDefined();
      expect(typeof ext.install).toBe('function');
      // install should not throw (it registers hooks, the hooks themselves throw)
      ext.install(hooks);
    }
  });
});
