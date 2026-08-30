// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package registry serves the component registry read plane: five component
// families sharing one identity, search, and visibility contract.
package registry

// Family describes one component family's storage and filter surface.
type Family struct {
	// Name is the singular family name used in resolve and error strings.
	Name string
	// Prefix is the plural route segment, e.g. "mcps".
	Prefix string
	// ListingTable and VersionTable are the backing tables.
	ListingTable string
	VersionTable string
	// SearchFields are the ILIKE targets in contract order; l = listing
	// alias, v = version alias. The listing name is always first.
	SearchFields []string
	// ListFilters maps query parameters to SQL predicates on l/v aliases.
	ListFilters map[string]string
}

// Families holds the five component families keyed by route prefix.
var Families = map[string]Family{
	"mcps": {
		Name: "mcp", Prefix: "mcps",
		ListingTable: "mcp_listings", VersionTable: "mcp_versions",
		SearchFields: []string{"l.name", "l.slug", "l.namespace", "l.owner", "l.category",
			"v.description", "v.framework", "v.setup_instructions"},
		ListFilters: map[string]string{"category": "l.category = %s"},
	},
	"skills": {
		Name: "skill", Prefix: "skills",
		ListingTable: "skill_listings", VersionTable: "skill_versions",
		SearchFields: []string{"l.name", "l.slug", "l.namespace", "l.owner",
			"v.description", "v.task_type", "v.skill_path", "v.slash_command", "v.git_url",
			"v.skill_md_content", "v.delivery_mode", "v.target_agents::text", "v.supported_harnesses::text"},
		ListFilters: map[string]string{"task_type": "v.task_type = %s"},
	},
	"hooks": {
		Name: "hook", Prefix: "hooks",
		ListingTable: "hook_listings", VersionTable: "hook_versions",
		SearchFields: []string{"l.name", "l.slug", "l.namespace", "l.owner",
			"v.description", "v.event", "v.scope", "v.handler_type"},
		ListFilters: map[string]string{"event": "v.event = %s", "scope": "v.scope = %s"},
	},
	"prompts": {
		Name: "prompt", Prefix: "prompts",
		ListingTable: "prompt_listings", VersionTable: "prompt_versions",
		SearchFields: []string{"l.name", "l.slug", "l.namespace", "l.owner",
			"v.description", "v.category", "v.template"},
		ListFilters: map[string]string{"category": "v.category = %s"},
	},
	"sandboxes": {
		Name: "sandbox", Prefix: "sandboxes",
		ListingTable: "sandbox_listings", VersionTable: "sandbox_versions",
		SearchFields: []string{"l.name", "l.slug", "l.namespace", "l.owner",
			"v.description", "v.runtime_type", "v.image", "v.network_policy"},
		ListFilters: map[string]string{"runtime_type": "v.runtime_type = %s"},
	},
}
