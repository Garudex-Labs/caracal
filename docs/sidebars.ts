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
      type: 'doc',
      id: 'faq',
      label: 'FAQ',
    },
  ],
};

export default sidebars;
