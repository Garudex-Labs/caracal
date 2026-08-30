// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Loads the documentation markdown files referenced by the contextual help
 * panel (docs-map.ts and component submit helpers), bundled at build time via
 * Vite. Do not glob all docs. Some repo docs are contributor-only or deprecated.
 */

const docModules = import.meta.glob<string>([
	"../../../docs/core-concepts/README.md",
	"../../../docs/core-concepts/session-tracking.md",
	"../../../docs/getting-started/quickstart.md",
	"../../../docs/cli/prompt.md",
	"../../../docs/insights-config.md",
	"../../../docs/registry-mcp-helper.md",
	"../../../docs/registry-skill-helper.md",
	"../../../docs/registry-hook-helper.md",
	"../../../docs/registry-sandbox-helper.md",
	"../../../docs/self-hosting/authentication.md",
	"../../../docs/self-hosting/deployment-settings.md",
	"../../../docs/self-hosting/token-expiry.md",
	"../../../docs/self-hosting/trusted-proxies.md",
	"../../../docs/self-hosting/data-retention.md",
	"../../../docs/self-hosting/data-migration.md",
	"../../../docs/self-hosting/observability-settings.md",
	"../../../docs/self-hosting/resource-tuning.md",
	"../../../docs/self-hosting/miscellaneous.md",
	"../../../docs/self-hosting/telemetry.md",
	"../../../docs/self-hosting/troubleshooting.md",
	"../../../docs/reference/api-endpoints.md",
], {
	query: "?raw",
	import: "default",
});

function toGlobKey(relativePath: string): string {
	return `../../../docs/${relativePath}`;
}

export async function loadDoc(relativePath: string): Promise<string | null> {
	const key = toGlobKey(relativePath);
	const loader = docModules[key];
	if (!loader) {
		console.warn(`[docs-loader] No doc found for path: ${relativePath} (key: ${key})`);
		return null;
	}
	return loader();
}
