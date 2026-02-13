import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  caracalSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: 'Home',
    },
    {
      type: 'category',
      label: 'Caracal Core',
      link: { type: 'doc', id: 'caracalCore/index' },
      items: [
        {
          type: 'category',
          label: 'Getting Started',
          items: [
            'caracalCore/gettingStarted/introduction',
            'caracalCore/gettingStarted/installation',
            'caracalCore/gettingStarted/quickstart',
          ],
        },
        {
          type: 'category',
          label: 'Concepts',
          items: [
            'caracalCore/concepts/architecture',
            'caracalCore/concepts/coreVsFlow',
          ],
        },
        {
          type: 'category',
          label: 'CLI Reference',
          link: { type: 'doc', id: 'caracalCore/cliReference/index' },
          items: [
            'caracalCore/cliReference/agent',
            'caracalCore/cliReference/policy',
            'caracalCore/cliReference/ledger',
            'caracalCore/cliReference/database',
            'caracalCore/cliReference/merkle',
            'caracalCore/cliReference/delegation',
            'caracalCore/cliReference/pricebook',
            'caracalCore/cliReference/backup',
            'caracalCore/cliReference/kafka',
            'caracalCore/cliReference/keys',
          ],
        },
        {
          type: 'category',
          label: 'API Reference',
          items: [
            'caracalCore/apiReference/sdkClient',
            'caracalCore/apiReference/mcpIntegration',
            'caracalCore/apiReference/mcpDecorators',
          ],
        },
        {
          type: 'category',
          label: 'Deployment',
          items: [
            'caracalCore/deployment/dockerCompose',
            'caracalCore/deployment/kubernetes',
            'caracalCore/deployment/kubernetesAdvanced',
            'caracalCore/deployment/production',
            'caracalCore/deployment/operationalRunbook',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Caracal Flow',
      link: { type: 'doc', id: 'caracalFlow/index' },
      items: [
        {
          type: 'category',
          label: 'Getting Started',
          items: [
            'caracalFlow/gettingStarted/introduction',
            'caracalFlow/gettingStarted/quickstart',
          ],
        },
        {
          type: 'category',
          label: 'Guides',
          items: [
            'caracalFlow/guides/configuration',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Development',
      items: [
        'development/contributing',
        'development/versionManagement',
      ],
    },
    {
      type: 'category',
      label: 'Caracal Enterprise',
      link: { type: 'doc', id: 'caracalEnterprise/gettingStarted/index' },
      items: [
        {
          type: 'category',
          label: 'Getting Started',
          items: [
            'caracalEnterprise/gettingStarted/index',
            'caracalEnterprise/gettingStarted/setup',
          ],
        },
        {
          type: 'category',
          label: 'Guides',
          items: [
            'caracalEnterprise/guides/sdkIntegration',
            'caracalEnterprise/guides/gatewayDeployment',
            'caracalEnterprise/guides/principalManagement',
          ],
        },
        'caracalEnterprise/architecture',
        'caracalEnterprise/features',
      ],
    },
    {
      type: 'doc',
      id: 'faq',
      label: 'FAQ',
    },
  ],
};

export default sidebars;
