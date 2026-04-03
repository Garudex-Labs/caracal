import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docsSidebar: [
    "start/index",
    {
      type: "category",
      label: "Open Source",
      link: {
        type: "doc",
        id: "open-source/overview/index",
      },
      items: [
        "open-source/end-users/index",
        "open-source/developers/index",
      ],
    },
    {
      type: "category",
      label: "Enterprise",
      link: {
        type: "doc",
        id: "enterprise/overview/index",
      },
      items: [
        "enterprise/getting-started/index",
        "enterprise/access-auth/index",
        "enterprise/configuration/index",
        "enterprise/administration/index",
        "enterprise/deployment/index",
        "enterprise/monitoring/index",
        "enterprise/troubleshooting/index",
      ],
    },
    {
      type: "category",
      label: "SDK",
      items: [
        {
          type: "category",
          label: "Open Source",
          link: {
            type: "doc",
            id: "open-source/sdk/overview/index",
          },
          items: [
            "open-source/sdk/installation/index",
            "open-source/sdk/usage/index",
            "open-source/sdk/api-surface/index",
            "open-source/sdk/examples/index",
            "open-source/sdk/advanced/index",
          ],
        },
        {
          type: "category",
          label: "Enterprise",
          link: {
            type: "doc",
            id: "enterprise/sdk/overview/index",
          },
          items: [
            "enterprise/sdk/installation/index",
            "enterprise/sdk/usage/index",
            "enterprise/sdk/api-surface/index",
            "enterprise/sdk/examples/index",
            "enterprise/sdk/advanced/index",
          ],
        },
      ],
    },
    {
      type: "category",
      label: "Build",
      items: [
        "start/build",
        "open-source/developers/development-setup/index",
        "open-source/developers/architecture/index",
        "open-source/developers/runtime-model/index",
        "open-source/developers/services-and-integrations/index",
        "open-source/developers/storage-and-data/index",
        "open-source/developers/core-authority-system/index",
        "open-source/developers/flow-tui/index",
        "open-source/developers/testing/index",
        "open-source/developers/enterprise-connector/index",
        "open-source/developers/contributing/index",
        "open-source/developers/releases/index",
        "open-source/developers/changelog/index",
      ],
    },
    {
      type: "category",
      label: "Manage",
      items: [
        "start/manage",
        "open-source/end-users/getting-started/installation",
        "open-source/end-users/getting-started/quickstart",
        "open-source/end-users/cli/index",
        "open-source/end-users/tui/index",
        "open-source/end-users/configuration/index",
        "open-source/end-users/workflows/index",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: [
        "start/reference",
        "open-source/end-users/concepts/index",
        "open-source/end-users/commands/index",
        "enterprise/reference/index",
      ],
    },
    {
      type: "category",
      label: "Resources",
      items: [
        "start/resources",
        "open-source/end-users/security/index",
        "open-source/end-users/troubleshooting/index",
        "resources/documentation-system/rulebook",
        "resources/documentation-system/structure",
      ],
    },
  ],
};

export default sidebars;
