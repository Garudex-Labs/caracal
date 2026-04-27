import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Caracal Docs",
  tagline: "Authority enforcement docs for operators, integrators, and contributors",
  favicon: "img/caracal.png",
  future: {
    v4: true,
  },
  url: "https://docs.garudexlabs.com",
  baseUrl: "/",
  organizationName: "Garudex-Labs",
  projectName: "Caracal",
  onBrokenLinks: "warn",
  markdown: {
    format: "mdx",
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
    mdx1Compat: {
      comments: true,
      admonitions: true,
      headingIds: true,
    },
    anchors: {
      maintainCase: true,
    },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },
  presets: [
    [
      "classic",
      {
        docs: {
          path: "content",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/Garudex-Labs/caracal/tree/main/docs/",
          showLastUpdateAuthor: false,
          showLastUpdateTime: false,
        },
        blog: false,
        pages: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],
  themes: [
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        docsRouteBasePath: "/",
        indexDocs: true,
        indexBlog: false,
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        searchBarShortcut: true,
        searchBarShortcutHint: true,
      },
    ],
  ],
  themeConfig: {
    image: "img/caracal.png",
    announcementBar: {
      id: "maintenance-v1",
      content:
        "<strong>Documentation is currently under maintenance and is being prepared for the v1.0.0 release soon.</strong>",
      backgroundColor: "#9BD34D",
      textColor: "#000000",
      isCloseable: false,
    },
    colorMode: {
      defaultMode: "dark",
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    docs: {
      sidebar: {
        autoCollapseCategories: false,
        hideable: true,
      },
    },
    navbar: {
      title: "Caracal Docs",
      hideOnScroll: false,
      logo: {
        alt: "Caracal Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          label: "Open Source",
          activeBaseRegex:
            "^/(?:open-source/overview(?:/|$)|open-source/end-users(?:/|$)|open-source/developers(?:/|$))",
          items: [
            { label: "Overview", to: "/open-source/overview" },
            { label: "End Users", to: "/open-source/end-users" },
            { label: "Developers", to: "/open-source/developers" },
          ],
          position: "left",
        },
        {
          label: "Enterprise",
          activeBaseRegex:
            "^/enterprise/(?:overview|getting-started|access-auth|configuration|administration|deployment|monitoring|troubleshooting|reference)(?:/|$)",
          items: [
            { label: "Overview", to: "/enterprise/overview" },
            { label: "Getting Started", to: "/enterprise/getting-started" },
            { label: "Access / Auth", to: "/enterprise/access-auth" },
            { label: "Configuration", to: "/enterprise/configuration" },
            { label: "Administration", to: "/enterprise/administration" },
            { label: "Deployment", to: "/enterprise/deployment" },
            { label: "Monitoring", to: "/enterprise/monitoring" },
            { label: "Troubleshooting", to: "/enterprise/troubleshooting" },
          ],
          position: "left",
        },
        {
          label: "SDK",
          activeBaseRegex:
            "^/(?:open-source/sdk|enterprise/sdk)(?:/|$)",
          items: [
            {
              type: "html",
              value: '<span class="dropdown__category-title">Open Source</span>',
            },
            { label: "Overview", to: "/open-source/sdk/overview" },
            { label: "Installation", to: "/open-source/sdk/installation" },
            { label: "Python SDK", to: "/open-source/sdk/python/usage" },
            { label: "Node SDK", to: "/open-source/sdk/node/usage" },
            { label: "Reference", to: "/open-source/sdk/reference/tool-id-grammar" },
            { label: "Examples", to: "/open-source/sdk/examples" },
            {
              type: "html",
              value: '<span class="dropdown__category-title">Enterprise</span>',
            },
            { label: "Overview", to: "/enterprise/sdk/overview" },
            { label: "Usage", to: "/enterprise/sdk/usage" },
            { label: "Examples", to: "/enterprise/sdk/examples" },
          ],
          position: "left",
        },
        {
          label: "Build",
          activeBaseRegex:
            "^/(?:build(?:/|$)|open-source/developers/(?:architecture|development-setup|testing|flow-tui|runtime-model|services-and-integrations|storage-and-data|core-authority-system|enterprise-connector|contributing|releases|changelog)(?:/|$))",
          items: [
            { label: "Build Hub", to: "/build" },
            { label: "Architecture", to: "/open-source/developers/architecture" },
            { label: "Development Setup", to: "/open-source/developers/development-setup" },
            { label: "Runtime Model", to: "/open-source/developers/runtime-model" },
            { label: "Services and Integrations", to: "/open-source/developers/services-and-integrations" },
            { label: "Storage and Data", to: "/open-source/developers/storage-and-data" },
            { label: "Core Authority System", to: "/open-source/developers/core-authority-system" },
            { label: "Flow TUI", to: "/open-source/developers/flow-tui" },
            { label: "Testing", to: "/open-source/developers/testing" },
            { label: "Enterprise Connector", to: "/open-source/developers/enterprise-connector" },
            { label: "Contributing", to: "/open-source/developers/contributing" },
            { label: "Releases", to: "/open-source/developers/releases" },
            { label: "Changelog", to: "/open-source/developers/changelog" },
          ],
          position: "left",
        },
        {
          label: "Manage",
          activeBaseRegex:
            "^/(?:manage(?:/|$)|open-source/end-users/getting-started/(?:installation|quickstart)(?:/|$)|open-source/end-users/(?:cli|tui|configuration|workflows)(?:/|$))",
          items: [
            { label: "Manage Hub", to: "/manage" },
            { label: "Installation", to: "/open-source/end-users/getting-started/installation" },
            { label: "Quickstart", to: "/open-source/end-users/getting-started/quickstart" },
            { label: "CLI", to: "/open-source/end-users/cli" },
            { label: "TUI", to: "/open-source/end-users/tui" },
            { label: "Configuration", to: "/open-source/end-users/configuration" },
            { label: "Workflows", to: "/open-source/end-users/workflows" },
          ],
          position: "left",
        },
        {
          label: "Reference",
          activeBaseRegex:
            "^/(?:reference(?:/|$)|open-source/end-users/(?:cli|configuration|concepts)(?:/|$)|open-source/sdk/reference(?:/|$)|enterprise/reference(?:/|$))",
          items: [
            { label: "Reference Hub", to: "/reference" },
            { label: "CLI", to: "/open-source/end-users/cli" },
            { label: "Configuration", to: "/open-source/end-users/configuration" },
            { label: "Concepts", to: "/open-source/end-users/concepts" },
            { label: "SDK Reference", to: "/open-source/sdk/reference/tool-id-grammar" },
            { label: "Enterprise Reference", to: "/enterprise/reference" },
          ],
          position: "left",
        },
        {
          label: "Resources",
          activeBaseRegex:
            "^/(?:resources(?:/|$)|open-source/end-users/(?:security|troubleshooting)(?:/|$))",
          items: [
            { label: "Resources Hub", to: "/resources" },
            { label: "Security", to: "/open-source/end-users/security" },
            { label: "Troubleshooting", to: "/open-source/end-users/troubleshooting" },
            { label: "Rulebook", to: "/resources/documentation-system/rulebook" },
            { label: "Structure", to: "/resources/documentation-system/structure" },
          ],
          position: "left",
        },
        {
          type: "search",
          position: "right",
        },
        {
          type: "html",
          position: "right",
          value:
            '<a class="caracal-github-link" href="https://github.com/Garudex-Labs/caracal" target="_blank" rel="noreferrer" aria-label="Caracal on GitHub"><svg class="caracal-github-link__icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-1.96c-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.35.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a10.9 10.9 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.73.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.26 5.68.41.35.78 1.05.78 2.12v3.14c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg><img class="caracal-github-link__badge" alt="GitHub star count" src="https://img.shields.io/github/stars/Garudex-Labs/caracal?style=flat-square&amp;label=&amp;color=9bd34d&amp;labelColor=11161c" /></a>',
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Start",
          items: [
            {
              label: "Landing Page",
              to: "/",
            },
            {
              label: "Open Source Overview",
              to: "/open-source/overview",
            },
            {
              label: "Enterprise Overview",
              to: "/enterprise/overview",
            },
          ],
        },
        {
          title: "Support",
          items: [
            {
              label: "support@garudexlabs.com",
              href: "mailto:support@garudexlabs.com",
            },
            {
              label: "Enterprise Sales",
              href: "https://cal.com/rawx18/caracal-enterprise-sales",
            },
            {
              label: "Open Source Calls",
              href: "https://cal.com/rawx18/open-source",
            },
          ],
        },
        {
          title: "Reference",
          items: [
            {
              label: "Rulebook",
              to: "/resources/documentation-system/rulebook",
            },
            {
              label: "Structure",
              to: "/resources/documentation-system/structure",
            },
            {
              label: "Security",
              to: "/open-source/end-users/security",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Garudex Labs.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: ["bash", "json", "yaml", "toml", "typescript"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
