// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// ── Registry ────────────────────────────────────────────────────────

/** GET /registry/resolve: canonical identity for a UUID or namespace/slug reference. */
export interface RegistryResolution {
	id: string;
	type: string;
	namespace: string;
	slug: string;
	qualified_name: string;
}

export interface RegistryItem {
	id: string;
	name: string;
	namespace?: string;
	slug?: string;
	qualified_name?: string;
	project_id?: string | null;
	visibility?: "project" | "private";
	is_private?: boolean;
	description?: string;
	status?: string;
	rejection_reason?: string;
	created_at?: string;
	deleted_at?: string | null;
	scheduled_purge_at?: string | null;
	updated_at?: string;
	[key: string]: unknown;
}

/** A component (or legacy MCP) linked to an agent or one of its versions. */
export interface AgentComponentLink {
	component_name?: string;
	mcp_name?: string;
	name?: string;
	component_type?: string;
	component_id?: string;
	mcp_id?: string;
	namespace?: string;
	slug?: string;
	qualified_name?: string;
	resolved_version?: string;
	status?: string;
}

/** Agent payload refinement of RegistryItem shared by the detail and edit surfaces. */
export interface AgentDetail {
	name: string;
	status?: string;
	version?: string;
	owner?: string;
	user_permission?: string;
	project_id?: string | null;
	visibility?: "project" | "private";
	is_private?: boolean;
	description?: string;
	prompt?: string;
	model_name?: string;
	models_by_harness?: Record<string, string>;
	download_count?: number;
	created_by?: string;
	created_at?: string;
	component_links?: AgentComponentLink[];
	mcp_links?: AgentComponentLink[];
	supported_harnesses?: string[];
	required_capabilities?: string[];
	inferred_supported_harnesses?: string[];
	[key: string]: unknown;
}

// ── Agent enriched types ────────────────────────────────────────────

export interface TopAgentItem {
	id: string;
	name: string;
	namespace?: string;
	slug?: string;
	qualified_name?: string;
	description: string;
	owner: string;
	created_by_username?: string | null;
	version: string;
	download_count: number;
}

export interface VersionSuggestions {
	current: string;
	suggestions: {
		patch: string;
		minor: string;
		major: string;
	};
}

export interface AgentVersionSummary {
	id: string;
	agent_id: string;
	version: string;
	description: string;
	status: string;
	is_prerelease: boolean;
	download_count: number;
	supported_harnesses: string[];
	released_by: string;
	released_at: string | null;
	created_at: string | null;
	rejection_reason: string | null;
	component_count: number;
}

export interface AgentVersionsResponse {
	items: AgentVersionSummary[];
	total: number;
	page: number;
	page_size: number;
}

export interface AgentComponentReference {
	component_type: string;
	component_id: string;
	name?: string;
	component_name?: string;
	mcp_name?: string;
	resolved_version?: string;
	status?: string;
}

export interface SuccessMetric {
	name: string;
	target: string;
	measurement: string;
}

export interface SuccessCriteria {
	intended_purpose: string;
	success_metrics: SuccessMetric[];
	evaluation_notes: string;
}

export interface AgentVersionDetail extends AgentVersionSummary {
	prompt: string;
	model_name: string;
	model_config_json?: Record<string, unknown>;
	models_by_harness?: Record<string, string>;
	external_mcps?: unknown[];
	yaml_snapshot?: unknown;
	harness_configs?: Record<string, unknown>;
	required_capabilities?: string[];
	inferred_supported_harnesses?: string[];
	components: AgentComponentReference[];
	success_criteria?: SuccessCriteria | null;
}

// ── Component Versions ─────────────────────────────────────────────

export interface ComponentVersionSummary {
	id: string;
	listing_id: string;
	version: string;
	description: string;
	changelog: string | null;
	status: string;
	rejection_reason: string | null;
	download_count: number;
	supported_harnesses: string[];
	released_by: string;
	released_at: string | null;
	created_at: string | null;
	// Hook fields
	event?: string;
	execution_mode?: string;
	priority?: number;
	handler_type?: string;
	handler_config?: Record<string, unknown>;
	scope?: string;
	tool_filter?: Record<string, unknown>;
	script_content?: string;
	script_filename?: string;
	source_path?: string;
	requirements?: string[];
	// Skill fields
	skill_path?: string;
	git_url?: string;
	git_ref?: string;
	skill_md_content?: string;
	validated?: boolean;
	target_agents?: string[];
	task_type?: string;
	slash_command?: string;
	// Prompt fields
	category?: string;
	template?: string;
	variables?: unknown[];
	tags?: string[];
	// MCP source fields
	source_url?: string;
	source_ref?: string;
	resolved_sha?: string;
}

export interface ComponentVersionsResponse {
	items: ComponentVersionSummary[];
	total: number;
	page: number;
	page_size: number;
}

export type ComponentVersionDetail = ComponentVersionSummary;

export interface BulkResultItem {
	name: string;
	status: "created" | "skipped" | "error";
	agent_id?: string | null;
	error?: string | null;
}

export interface BulkResult {
	total: number;
	created: number;
	skipped: number;
	errors: number;
	dry_run: boolean;
	results: BulkResultItem[];
}

export interface ValidationIssue {
	severity: "error" | "warning";
	component_type?: string;
	component_id?: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
}

// ── Version Diff ────────────────────────────────────────────────────

export interface ComponentChange {
	type: string;
	name: string;
	change: "added" | "removed" | "updated";
	version?: string;
	from?: string;
	to?: string;
}

export interface VersionDiff {
	agent_id: string;
	version_a: string;
	version_b: string;
	yaml_diff: string;
	component_changes: ComponentChange[];
}

// ── Review ──────────────────────────────────────────────────────────

export interface McpValidationResult {
	stage: string;
	passed: boolean;
	details?: string;
	run_at?: string;
}

export interface ReviewItem {
	id: string;
	name?: string;
	description?: string;
	version?: string;
	owner?: string;
	type?: string;
	listing_type?: string;
	submitted_by?: string;
	submitted_at?: string;
	created_at?: string;
	updated_at?: string;
	status?: string;
	mcp_validated?: boolean;
	validation_results?: McpValidationResult[];
	components_ready?: boolean;
	component_blockers?: {
		component_type: string;
		component_id: string;
		name: string;
		status: string;
	}[];
	bundle_id?: string;
	bundle_name?: string;
	rejection_reason?: string;

	// Common detail fields
	git_url?: string;
	git_ref?: string;
	supported_harnesses?: string[];

	// MCP-specific
	transport?: string;
	framework?: string;
	docker_image?: string;
	command?: string;
	args?: string[];
	url?: string;
	headers?: unknown[];
	auto_approve?: string[];
	tools_schema?: Record<string, unknown>;
	environment_variables?: unknown[];
	setup_instructions?: string;
	changelog?: string;

	// Skill-specific
	skill_path?: string;
	skill_md_content?: string;
	validated?: boolean;
	target_agents?: string[];
	task_type?: string;
	slash_command?: string;

	// Hook-specific
	event?: string;
	execution_mode?: string;
	handler_type?: string;
	handler_config?: Record<string, unknown>;
	scope?: string;
	tool_filter?: string[];
	priority?: number;
	script_content?: string;
	script_filename?: string;
	source_url?: string;
	source_ref?: string;
	source_path?: string;
	resolved_sha?: string;
	requirements?: string[];

	// Prompt-specific
	category?: string;
	template?: string;
	variables?: unknown[];
	tags?: string[];

	validated_at?: string;

	// Agent-specific
	prompt?: string;
	model_name?: string;
	model_config_json?: Record<string, unknown>;
	external_mcps?: unknown[];
	required_capabilities?: string[];
	component_count?: number;
	components?: { component_type: string; component_id: string }[];
	success_criteria?: SuccessCriteria | null;
}

// ── Unified project resources (agents + all component types) ───────

export interface ProjectResource {
	id: string;
	resource_type: "agents" | "mcps" | "skills" | "hooks" | "prompts";
	name: string;
	namespace: string;
	slug: string;
	qualified_name: string;
	description?: string | null;
	status?: string | null;
	version?: string | null;
	visibility?: "project" | "private";
	ownership_scope?: "private" | "project";
	owner?: string | null;
	project_id?: string | null;
	downloads?: number | null;
	created_at?: string | null;
	updated_at?: string | null;
}

export interface ProjectResourcesResponse {
	items: ProjectResource[];
	counts: Record<string, number>;
	total: number;
	page: number;
	page_size: number;
}

// ── Review issues: resolvable feedback attached to a change ─────────

export interface ReviewIssueActor {
	id: string;
	username?: string | null;
	name?: string | null;
}

export interface ReviewIssueComment {
	id: string;
	author: ReviewIssueActor | null;
	body: string;
	created_at?: string | null;
}

export interface ReviewIssue {
	id: string;
	subject_type: string;
	subject_id: string;
	version_id?: string | null;
	context?: string | null;
	title: string;
	body?: string | null;
	status: "open" | "resolved";
	author: ReviewIssueActor | null;
	resolved_by?: ReviewIssueActor | null;
	resolved_at?: string | null;
	created_at?: string | null;
	comments: ReviewIssueComment[];
}

export interface ReviewIssuesResponse {
	subject_type: string;
	subject_id: string;
	open_count: number;
	issues: ReviewIssue[];
}

// ── Resource lifecycle: derived activity timeline + contributor roster ──

export type ResourceActivityEventType =
	| "resource_created"
	| "change_opened"
	| "version_published"
	| "change_rejected"
	| "version_restored"
	| "issue_opened"
	| "issue_comment"
	| "issue_resolved";

export interface ResourceActivityEvent {
	type: ResourceActivityEventType;
	at: string | null;
	actor: ReviewIssueActor | null;
	version?: string | null;
	version_id?: string | null;
	issue_id?: string | null;
	detail?: string | null;
}

export interface ResourceActivityResponse {
	subject_type: string;
	subject_id: string;
	total: number;
	events: ResourceActivityEvent[];
}

export interface ResourceContributor {
	user: ReviewIssueActor | null;
	is_creator: boolean;
	changes_opened: number;
	versions_published: number;
	reviews: number;
	issues_opened: number;
	issues_resolved: number;
	comments: number;
	last_activity_at: string | null;
}

export interface ResourceContributorsResponse {
	subject_type: string;
	subject_id: string;
	total: number;
	contributors: ResourceContributor[];
}

// ── Scores ──────────────────────────────────────────────────────────

export interface Score {
	score_id: string;
	trace_id: string;
	span_id?: string;
	name: string;
	source: string;
	data_type: string;
	value?: number;
	string_value?: string;
	comment?: string;
	timestamp: string;
}

// ── Personalised recommendations ──────────────────────────────────────────

export interface RecommendationItem {
	type: string;
	id: string;
	name: string;
	namespace: string;
	slug: string;
	qualified_name: string;
	description: string;
	category: string | null;
	latest_version: string;
	download_count: number;
	matched_on: string[];
	score: number;
	reason: string;
}

export interface RecommendationsResponse {
	items: RecommendationItem[];
	/** False when the user has no session history, so the UI can say so. */
	personalized: boolean;
	profile_sessions: number;
	topics: string[];
}
