import type { PropSidebar, PropSidebarItem, PropSidebarItemCategory } from "@docusaurus/plugin-content-docs";

function link(label: string, href: string): PropSidebarItem {
  return { type: "link", label, href };
}

function category(
  label: string,
  href: string | undefined,
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

const sdkSidebar = [
  category(
    "SDK",
    "/open-source/sdk/overview",
    [
      link("Overview", "/open-source/sdk/overview"),
      link("Installation", "/open-source/sdk/installation"),
      category("Python", "/open-source/sdk/python/usage", [
        link("Usage", "/open-source/sdk/python/usage"),
        link("API Surface", "/open-source/sdk/python/api-surface"),
        link("Examples", "/open-source/sdk/python/examples"),
        link("Advanced", "/open-source/sdk/python/advanced"),
      ]),
      category("Node", "/open-source/sdk/node/usage", [
        link("Usage", "/open-source/sdk/node/usage"),
        link("API Surface", "/open-source/sdk/node/api-surface"),
        link("Examples", "/open-source/sdk/node/examples"),
        link("Advanced", "/open-source/sdk/node/advanced"),
      ]),
      category("Reference", "/open-source/sdk/reference/tool-id-grammar", [
        link("Tool ID Grammar", "/open-source/sdk/reference/tool-id-grammar"),
        link("Adapter Contract", "/open-source/sdk/reference/adapter-contract"),
        link("Hook Points", "/open-source/sdk/reference/hook-points"),
        link("Extension Contract", "/open-source/sdk/reference/extension-contract"),
        link("Error Taxonomy", "/open-source/sdk/reference/error-taxonomy"),
      ]),
      link("Examples", "/open-source/sdk/examples"),
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
    ],
    false,
  ),
] satisfies PropSidebar;

const enterpriseSdkSidebar = [
  category(
    "Enterprise SDK",
    "/enterprise/sdk/overview",
    [
      link("Overview", "/enterprise/sdk/overview"),
      link("Usage", "/enterprise/sdk/usage"),
      link("Examples", "/enterprise/sdk/examples"),
    ],
    false,
  ),
] satisfies PropSidebar;

const buildSidebar = [
  category(
    "Build",
    "/build",
    [
      link("Build Hub", "/build"),
    ],
    false,
  ),
] satisfies PropSidebar;

const manageSidebar = [
  category(
    "Manage",
    "/manage",
    [
      link("Manage Hub", "/manage"),
    ],
    false,
  ),
] satisfies PropSidebar;

const referenceSidebar = [
  category(
    "Reference",
    "/reference",
    [
      link("Reference Hub", "/reference"),
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
    ],
    false,
  ),
] satisfies PropSidebar;

const aiSidebar = [
  category(
    "AI Docs",
    "/ai",
    [
      category("End Users", undefined, [
        link("Installation", "/ai/open-source/end-users/getting-started/installation"),
        category("Concepts", "/ai/open-source/end-users/concepts", [
          link("Authority Enforcement Model", "/ai/open-source/end-users/concepts/authority-enforcement-model"),
          link("Principal", "/ai/open-source/end-users/concepts/principal"),
          link("Policy", "/ai/open-source/end-users/concepts/policy"),
          link("Mandate", "/ai/open-source/end-users/concepts/mandate"),
          link("Delegation", "/ai/open-source/end-users/concepts/delegation"),
          link("Caveat", "/ai/open-source/end-users/concepts/caveat"),
          link("Workspace", "/ai/open-source/end-users/concepts/workspace"),
          link("Intent", "/ai/open-source/end-users/concepts/intent"),
          link("Ledger", "/ai/open-source/end-users/concepts/ledger"),
          link("AI Service Isolation", "/ai/open-source/end-users/concepts/ai-service-isolation"),
          link("Master Encryption Key", "/ai/open-source/end-users/concepts/master-encryption-key"),
          link("Broker vs Gateway", "/ai/open-source/end-users/concepts/broker-vs-gateway"),
        ]),
        category("CLI", "/ai/open-source/end-users/cli", [
          link("Host Commands", "/ai/open-source/end-users/cli/host-commands"),
          link("Authority", "/ai/open-source/end-users/cli/authority"),
          link("Policy", "/ai/open-source/end-users/cli/policy"),
          link("Principal", "/ai/open-source/end-users/cli/principal"),
          link("Delegation", "/ai/open-source/end-users/cli/delegation"),
          link("Workspace", "/ai/open-source/end-users/cli/workspace"),
          link("Provider", "/ai/open-source/end-users/cli/provider"),
          link("Audit", "/ai/open-source/end-users/cli/audit"),
          link("Doctor", "/ai/open-source/end-users/cli/doctor"),
        ]),
        link("TUI", "/ai/open-source/end-users/tui/common-tasks"),
        category("Configuration", "/ai/open-source/end-users/configuration", [
          link("Environment Variables", "/ai/open-source/end-users/configuration/environment-variables"),
          link("Database", "/ai/open-source/end-users/configuration/database"),
          link("Redis", "/ai/open-source/end-users/configuration/redis"),
          link("MCP Adapter", "/ai/open-source/end-users/configuration/mcp-adapter"),
          link("Allowlist", "/ai/open-source/end-users/configuration/allowlist"),
          link("Logging", "/ai/open-source/end-users/configuration/logging"),
          link("Merkle", "/ai/open-source/end-users/configuration/merkle"),
          link("Snapshot", "/ai/open-source/end-users/configuration/snapshot"),
        ]),
        category("Workflows", "/ai/open-source/end-users/workflows", [
          link("Register a Principal", "/ai/open-source/end-users/workflows/register-a-principal"),
          link("Author a Policy", "/ai/open-source/end-users/workflows/author-a-policy"),
          link("Issue a Mandate", "/ai/open-source/end-users/workflows/issue-a-mandate"),
          link("Delegate Authority", "/ai/open-source/end-users/workflows/delegate-authority"),
          link("Revoke a Mandate", "/ai/open-source/end-users/workflows/revoke-a-mandate"),
          link("Inspect the Ledger", "/ai/open-source/end-users/workflows/inspect-the-ledger"),
          link("Rotate Keys", "/ai/open-source/end-users/workflows/rotate-keys"),
          link("Back Up and Restore", "/ai/open-source/end-users/workflows/back-up-and-restore"),
        ]),
        category("Security", undefined, [
          link("Threat Model", "/ai/open-source/end-users/security/threat-model"),
          link("Fail-Closed Semantics", "/ai/open-source/end-users/security/fail-closed-semantics"),
          link("Attestation and Sessions", "/ai/open-source/end-users/security/attestation-and-sessions"),
          link("Key Management", "/ai/open-source/end-users/security/key-management"),
          link("Ledger Integrity", "/ai/open-source/end-users/security/ledger-integrity"),
          link("Revocation Propagation", "/ai/open-source/end-users/security/revocation-propagation"),
        ]),
        category("Troubleshooting", undefined, [
          link("Common Failures", "/ai/open-source/end-users/troubleshooting/common-failures"),
          link("Doctor", "/ai/open-source/end-users/troubleshooting/doctor"),
          link("Logs", "/ai/open-source/end-users/troubleshooting/logs"),
          link("Reset vs Purge", "/ai/open-source/end-users/troubleshooting/reset-vs-purge"),
        ]),
      ]),
      category("SDK", undefined, [
        link("Installation", "/ai/open-source/sdk/installation"),
        category("Python", undefined, [
          link("Usage", "/ai/open-source/sdk/python/usage"),
          link("API Surface", "/ai/open-source/sdk/python/api-surface"),
          link("Examples", "/ai/open-source/sdk/python/examples"),
          link("Advanced", "/ai/open-source/sdk/python/advanced"),
        ]),
        category("Node", undefined, [
          link("Usage", "/ai/open-source/sdk/node/usage"),
          link("API Surface", "/ai/open-source/sdk/node/api-surface"),
          link("Examples", "/ai/open-source/sdk/node/examples"),
          link("Advanced", "/ai/open-source/sdk/node/advanced"),
        ]),
        category("Reference", undefined, [
          link("Tool ID Grammar", "/ai/open-source/sdk/reference/tool-id-grammar"),
          link("Adapter Contract", "/ai/open-source/sdk/reference/adapter-contract"),
          link("Hook Points", "/ai/open-source/sdk/reference/hook-points"),
          link("Extension Contract", "/ai/open-source/sdk/reference/extension-contract"),
          link("Error Taxonomy", "/ai/open-source/sdk/reference/error-taxonomy"),
        ]),
      ]),
      category("Developers", undefined, [
        link("Architecture", "/ai/open-source/developers/architecture"),
        link("Runtime Model", "/ai/open-source/developers/runtime-model"),
        link("Core Authority System", "/ai/open-source/developers/core-authority-system"),
        link("Services and Integrations", "/ai/open-source/developers/services-and-integrations"),
      ]),
      category("Enterprise", undefined, [
        link("Access / Auth", "/ai/enterprise/access-auth"),
        link("Configuration", "/ai/enterprise/configuration"),
        link("Reference", "/ai/enterprise/reference"),
        link("SDK Usage", "/ai/enterprise/sdk/usage"),
        link("SDK Examples", "/ai/enterprise/sdk/examples"),
      ]),
      category("Resources", undefined, [
        link("Glossary", "/ai/resources/glossary"),
      ]),
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
    return expandForActivePath(aiSidebar, pathname);
  }

  if (pathname.startsWith("/open-source/sdk")) {
    return expandForActivePath(sdkSidebar, pathname);
  }

  if (pathname.startsWith("/enterprise/sdk")) {
    return expandForActivePath(enterpriseSdkSidebar, pathname);
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
