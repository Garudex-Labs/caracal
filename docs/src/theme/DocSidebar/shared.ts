import type { PropSidebar, PropSidebarItem, PropSidebarItemCategory } from "@docusaurus/plugin-content-docs";

function link(label: string, href: string): PropSidebarItem {
  return { type: "link", label, href };
}

function category(
  label: string,
  href: string,
  items: PropSidebarItem[],
  collapsible = true,
): PropSidebarItemCategory {
  return {
    type: "category",
    label,
    href,
    items,
    collapsible,
    collapsed: false,
  };
}

const openSourceSidebar = [
  category(
    "Open Source",
    "/open-source/overview",
    [
      category("End Users", "/open-source/end-users", [
        category("Getting Started", "/open-source/end-users/getting-started", [
          link("Installation", "/open-source/end-users/getting-started/installation"),
          link("Quickstart", "/open-source/end-users/getting-started/quickstart"),
        ]),
        link("Concepts", "/open-source/end-users/concepts"),
        link("CLI", "/open-source/end-users/cli"),
        link("TUI", "/open-source/end-users/tui"),
        link("Configuration", "/open-source/end-users/configuration"),
        link("Workflows", "/open-source/end-users/workflows"),
        link("Security", "/open-source/end-users/security"),
        link("Troubleshooting", "/open-source/end-users/troubleshooting"),
      ]),
      category("SDK", "/open-source/sdk/overview", [
        link("Overview", "/open-source/sdk/overview"),
        link("Installation", "/open-source/sdk/installation"),
        link("Python SDK", "/open-source/sdk/python/usage"),
        link("Node SDK", "/open-source/sdk/node/usage"),
        link("Reference", "/open-source/sdk/reference/tool-id-grammar"),
        link("Examples", "/open-source/sdk/examples"),
      ]),
      category("Developers", "/open-source/developers", [
        link("Architecture", "/open-source/developers/architecture"),
        link("Development Setup", "/open-source/developers/development-setup"),
        link("Runtime Model", "/open-source/developers/runtime-model"),
        link("Services and Integrations", "/open-source/developers/services-and-integrations"),
        link("Storage and Data", "/open-source/developers/storage-and-data"),
        link("Core Authority System", "/open-source/developers/core-authority-system"),
        link("Flow Internals", "/open-source/developers/flow-tui"),
        link("Testing", "/open-source/developers/testing"),
        link("Enterprise Connector", "/open-source/developers/enterprise-connector"),
        link("Contributing", "/open-source/developers/contributing"),
        link("Releases", "/open-source/developers/releases"),
        link("Changelog", "/open-source/developers/changelog"),
      ]),
    ],
    false,
  ),
] satisfies PropSidebar;

const enterpriseSidebar = [
  category(
    "Enterprise",
    "/enterprise/overview",
    [
      link("Overview", "/enterprise/overview"),
      link("Getting Started", "/enterprise/getting-started"),
      link("Access / Auth", "/enterprise/access-auth"),
      link("Configuration", "/enterprise/configuration"),
      link("Administration", "/enterprise/administration"),
      link("Deployment", "/enterprise/deployment"),
      link("Monitoring", "/enterprise/monitoring"),
      link("Troubleshooting", "/enterprise/troubleshooting"),
      link("Reference", "/enterprise/reference"),
      category("SDK", "/enterprise/sdk/overview", [
        link("Overview", "/enterprise/sdk/overview"),
        link("Usage", "/enterprise/sdk/usage"),
        link("Examples", "/enterprise/sdk/examples"),
      ]),
    ],
    false,
  ),
] satisfies PropSidebar;

const buildSidebar = [
  category(
    "Build",
    "/build",
    [
      link("Architecture", "/open-source/developers/architecture"),
      link("Development Setup", "/open-source/developers/development-setup"),
      link("Runtime Model", "/open-source/developers/runtime-model"),
      link("Core Authority System", "/open-source/developers/core-authority-system"),
      link("Testing", "/open-source/developers/testing"),
      link("Contributing", "/open-source/developers/contributing"),
      link("Releases", "/open-source/developers/releases"),
      link("Changelog", "/open-source/developers/changelog"),
    ],
    false,
  ),
] satisfies PropSidebar;

const manageSidebar = [
  category(
    "Manage",
    "/manage",
    [
      link("Installation", "/open-source/end-users/getting-started/installation"),
      link("Quickstart", "/open-source/end-users/getting-started/quickstart"),
      link("CLI", "/open-source/end-users/cli"),
      link("TUI", "/open-source/end-users/tui"),
      link("Configuration", "/open-source/end-users/configuration"),
      link("Workflows", "/open-source/end-users/workflows"),
      link("Troubleshooting", "/open-source/end-users/troubleshooting"),
    ],
    false,
  ),
] satisfies PropSidebar;

const referenceSidebar = [
  category(
    "Reference",
    "/reference",
    [
      link("CLI", "/open-source/end-users/cli"),
      link("Configuration", "/open-source/end-users/configuration"),
      link("Concepts", "/open-source/end-users/concepts"),
      link("SDK Reference", "/open-source/sdk/reference/tool-id-grammar"),
      link("Enterprise Reference", "/enterprise/reference"),
    ],
    false,
  ),
] satisfies PropSidebar;

const resourcesSidebar = [
  category(
    "Resources",
    "/resources",
    [
      link("Glossary", "/resources/glossary"),
      link("FAQ", "/resources/faq"),
      link("Support", "/resources/support"),
      category("Documentation System", "/resources/documentation-system/rulebook", [
        link("Rulebook", "/resources/documentation-system/rulebook"),
        link("Structure", "/resources/documentation-system/structure"),
      ]),
      link("Security", "/open-source/end-users/security"),
    ],
    false,
  ),
] satisfies PropSidebar;

function pathMatches(pathname: string, href?: string): boolean {
  if (!href) {
    return false;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function containsActivePath(item: PropSidebarItem, pathname: string): boolean {
  if (item.type === "link") {
    return pathMatches(pathname, item.href);
  }

  if (item.type === "category") {
    if (pathMatches(pathname, item.href)) {
      return true;
    }

    return item.items.some((child) => containsActivePath(child, pathname));
  }

  return false;
}

function expandForActivePath(items: PropSidebar, pathname: string): PropSidebar {
  return items.map((item) => {
    if (item.type !== "category") {
      return item;
    }

    return {
      ...item,
      collapsed: item.collapsible ? !containsActivePath(item, pathname) : false,
      items: expandForActivePath(item.items, pathname),
    };
  });
}

export function getSidebarForPath(pathname: string): PropSidebar {
  if (pathname === "/") {
    return [];
  }

  if (pathname.startsWith("/ai")) {
    return [];
  }

  if (pathname.startsWith("/open-source")) {
    return expandForActivePath(openSourceSidebar, pathname);
  }

  if (pathname.startsWith("/enterprise")) {
    return expandForActivePath(enterpriseSidebar, pathname);
  }

  if (pathname.startsWith("/build")) {
    return expandForActivePath(buildSidebar, pathname);
  }

  if (pathname.startsWith("/manage")) {
    return expandForActivePath(manageSidebar, pathname);
  }

  if (pathname.startsWith("/reference")) {
    return expandForActivePath(referenceSidebar, pathname);
  }

  if (pathname.startsWith("/resources")) {
    return expandForActivePath(resourcesSidebar, pathname);
  }

  return [];
}
