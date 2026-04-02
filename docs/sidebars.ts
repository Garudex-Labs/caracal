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
        {
          type: "category",
          label: "End Users",
          link: {
            type: "doc",
            id: "open-source/end-users/index",
          },
          items: [
            "open-source/end-users/getting-started/installation",
            "open-source/end-users/getting-started/quickstart",
            "open-source/end-users/cli/index",
            "open-source/end-users/tui/index",
            "open-source/end-users/configuration/index",
            "open-source/end-users/commands/index",
            "open-source/end-users/workflows/index",
            "open-source/end-users/troubleshooting/index",
            "open-source/end-users/security/index",
            "open-source/end-users/concepts/index",
          ],
        },
        {
          type: "category",
          label: "Developers",
          link: {
            type: "doc",
            id: "open-source/developers/index",
          },
          items: [
            "open-source/developers/architecture/index",
            "open-source/developers/contributing/index",
            "open-source/developers/development-setup/index",
            "open-source/developers/testing/index",
            "open-source/developers/releases/index",
            "open-source/developers/changelog/index",
            "open-source/developers/enterprise-connector/index",
          ],
        },
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
        "enterprise/configuration/index",
        "enterprise/administration/index",
        "enterprise/access-auth/index",
        "enterprise/deployment/index",
        "enterprise/monitoring/index",
        "enterprise/troubleshooting/index",
        "enterprise/reference/index",
      ],
    },
    {
      type: "category",
      label: "Hubs",
      items: [
        "start/build",
        "start/manage",
        "start/reference",
        "start/resources",
      ],
    },
    {
      type: "category",
      label: "Documentation System",
      items: ["resources/documentation-system/rulebook"],
    },
  ],
};

export default sidebars;
