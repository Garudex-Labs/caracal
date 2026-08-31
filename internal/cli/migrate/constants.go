// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package migrate implements the portable PostgreSQL and ClickHouse data
// migration engines behind caracal server migrate: JSONL + tar.gz registry
// archives and monthly Parquet telemetry exports, with manifests and
// SHA-256 checksums shared with the server-side migration tooling.
package migrate

import "regexp"

// defaultProjectID is the project assigned to imported telemetry rows.
const defaultProjectID = "default"

// insertOrder lists every exported table in FK-dependency order. The
// listing/version circular FKs are broken during import by disabling
// trigger-based enforcement via session_replication_role = 'replica'.
var insertOrder = []string{
	// Tier 0 - no FK dependencies
	"enterprise_config",
	"component_sources",
	// Tier 1 - deployment-wide records
	"users",
	"exporter_configs",
	// Tier 1.5 - FK to users
	"component_bundles",
	// Tier 2 - FK to orgs + users + component_bundles
	"mcp_listings",
	"skill_listings",
	"hook_listings",
	"prompt_listings",
	"agents",
	// Tier 2.5 - FK to listings/agents + users (version tables)
	"mcp_versions",
	"skill_versions",
	"hook_versions",
	"prompt_versions",
	"agent_versions",
	// Tier 3 - FK to listings/users
	"mcp_validation_results",
	"mcp_downloads",
	"skill_downloads",
	"hook_downloads",
	"prompt_downloads",
	"submissions",
	"alert_rules",
	// Tier 4 - FK to agents/agent_versions
	"agent_download_records",
	"component_download_records",
	// Tier 6 - FK to agent_versions (polymorphic component_id)
	"agent_components",
	// Tier 8 - FK to alert_rules
	"alert_history",
	// Tier 9 - FK to agents + users (insight tables)
	"insight_meta_cache",
	"insight_session_facets",
	"insight_session_meta",
	"insight_reports",
}

// jsonbColumns names the JSONB columns per table; they are cast to ::text
// on export so archive lines carry the serialized JSON form.
var jsonbColumns = map[string][]string{
	"agents": {"model_config_json", "external_mcps", "supported_harnesses"},
	"agent_versions": {
		"model_config_json",
		"external_mcps",
		"supported_harnesses",
		"required_capabilities",
		"inferred_supported_harnesses",
		"harness_configs",
		"gaming_flags",
		"models_by_harness",
	},
	"mcp_listings": {"tools_schema", "environment_variables", "supported_harnesses"},
	"mcp_versions": {"tools_schema", "environment_variables", "supported_harnesses", "args", "headers", "auto_approve"},
	"skill_listings": {
		"supported_harnesses", "target_agents", "triggers", "mcp_server_config", "activation_keywords",
	},
	"skill_versions": {
		"supported_harnesses", "target_agents", "triggers", "mcp_server_config", "activation_keywords",
	},
	"hook_listings":          {"supported_harnesses", "handler_config", "input_schema", "output_schema"},
	"hook_versions":          {"supported_harnesses", "handler_config", "input_schema", "output_schema"},
	"prompt_listings":        {"variables", "tags", "supported_harnesses"},
	"prompt_versions":        {"variables", "tags", "supported_harnesses"},
	"agent_components":       {"config_override"},
	"exporter_configs":       {"config"},
	"insight_reports":        {"metrics", "narrative", "aggregated_data"},
	"insight_session_facets": {"facets"},
	"insight_session_meta":   {"meta"},
	"insight_meta_cache":     {"session_metas"},
}

var uuidRe = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// tableCfg describes one ClickHouse telemetry table.
type tableCfg struct {
	Name    string
	Engine  string // "replacing" or "mergetree"
	TimeCol string
	FKCols  []string
}

var clickhouseTables = []tableCfg{
	{Name: "session_events", Engine: "replacing", TimeCol: "timestamp", FKCols: []string{"agent_id", "user_id"}},
	{Name: "session_checkpoints", Engine: "replacing", TimeCol: "updated_at", FKCols: []string{"user_id"}},
	{Name: "session_stats_agg", Engine: "replacing", TimeCol: "first_event_time", FKCols: []string{"agent_id", "user_id"}},
	{Name: "layer_snapshots", Engine: "replacing", TimeCol: "uploaded_at", FKCols: []string{"user_id"}},
	{Name: "audit_log", Engine: "mergetree", TimeCol: "timestamp", FKCols: []string{"actor_id"}},
	{Name: "security_events", Engine: "mergetree", TimeCol: "timestamp", FKCols: []string{}},
	{Name: "webhook_deliveries", Engine: "mergetree", TimeCol: "timestamp", FKCols: []string{}},
}

// epochSentinels are the min/max timestamps ClickHouse reports for empty tables.
var epochSentinels = map[string]bool{
	"":                        true,
	"1970-01-01 00:00:00.000": true,
	"1970-01-01 00:00:00":     true,
}
